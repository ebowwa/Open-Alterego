"""Modal ingest: pull personalization clips from R2 (via the collect relay)
into the ``silent-lip-reader-data`` volume so the existing ``prepare``/``train``
jobs run unchanged.

Design notes (see plan):
- Light image (``requests`` only). No torch/mediapipe/engine here — this function
  only downloads files and writes a CSV, so cold-start is seconds, not minutes.
- Modal holds NO R2 credentials. Clip list + splits come from the relay's
  ``GET /v1/collect/export``; per-object presigned GETs are minted on demand via
  ``POST /v1/collect/presign`` (creds stay on the relay). The only secret Modal
  needs is the relay base URL + bearer (Modal secret ``alterego-relay``).
- Writes ONLY ``/data/<speaker>/manifest.csv`` and ``/data/<speaker>/clips/*.mp4``
  (never ``processed/``), then commits the volume — mandatory, because
  ``prepare`` runs in a later container.
- Idempotent: clips already on the volume are skipped; the manifest is always
  rewritten from the latest export so deletes / split changes propagate.
"""

import __future__  # noqa: F401  (keep py2/3 hints consistent if back-ported)

import csv
import os
import re
import time
from pathlib import Path

import modal

DATA_ROOT = Path("/data")
DATA_VOLUME_NAME = "silent-lip-reader-data"

data_volume = modal.Volume.from_name(DATA_VOLUME_NAME, create_if_missing=True)

ingest_image = modal.Image.debian_slim(python_version="3.11").uv_pip_install("requests>=2.31")

app = modal.App("silent-lip-reader-ingest", image=ingest_image)

RELAY_BASE = os.environ.get("ALTEREGO_RELAY_BASE", "").rstrip("/")
RELAY_TOKEN = os.environ.get("ALTEREGO_RELAY_TOKEN", "")

PRESIGN_BATCH = 50
DOWNLOAD_CHUNK = 1 << 20  # 1 MiB
DOWNLOAD_RETRIES = 3


# --- sanitizers: must match the downstream contract exactly ------------------
def _safe_name(value: str) -> str:
    """cloud/modal/app.py::_safe_name — valid as a Modal dataset_name."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise ValueError(
            "speaker must start alphanumeric and contain only "
            "letters, numbers, dots, underscores, or hyphens"
        )
    return value


def _safe_component(value: str) -> str:
    """training/prepare_dataset.py::_safe_component — what `prepare` will turn
    the manifest id into. Re-applying it here guarantees the id we write matches
    what prepare produces downstream (no drift / collisions)."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-")
    if not cleaned:
        raise ValueError("id must contain at least one letter or number")
    return cleaned


# --- relay client ------------------------------------------------------------
def _headers() -> dict:
    if not RELAY_TOKEN:
        raise RuntimeError("ALTEREGO_RELAY_TOKEN is not set (Modal secret 'alterego-relay')")
    return {"Authorization": f"Bearer {RELAY_TOKEN}"}


def _export(speaker: str) -> dict:
    import requests

    url = f"{RELAY_BASE}/v1/collect/export?speaker={speaker}"
    resp = requests.get(url, headers=_headers(), timeout=60)
    resp.raise_for_status()
    return resp.json()


def _presign(speaker: str, clip_ids: list[str]) -> dict[str, str]:
    import requests

    url = f"{RELAY_BASE}/v1/collect/presign"
    resp = requests.post(
        url, headers=_headers(), json={"speaker": speaker, "clip_ids": clip_ids}, timeout=60
    )
    resp.raise_for_status()
    return resp.json().get("urls", {})


# --- manifest writer (pure, unit-tested) -------------------------------------
MANIFEST_COLUMNS = ["id", "video", "text", "split"]


def write_manifest(manifest_path: Path, examples: list[dict]) -> None:
    """Write /data/<speaker>/manifest.csv with columns id,video,text,split.

    `examples` items must carry at least clip_id, text, split. The manifest id
    and the `video` filename are derived from `_safe_component(clip_id)` so they
    are identical and stable across re-runs.
    """
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    rows = []
    for ex in examples:
        clip_id = _safe_component(ex["clip_id"])
        rows.append(
            {
                "id": clip_id,
                "video": f"clips/{clip_id}.mp4",
                "text": " ".join(str(ex["text"]).split()),
                "split": ex["split"],
            }
        )
    # Stable order: by split then id, so re-runs are byte-stable.
    split_order = {"train": 0, "val": 1, "test": 2}
    rows.sort(key=lambda r: (split_order.get(r["split"], 99), r["id"]))
    with tmp.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=MANIFEST_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(tmp, manifest_path)


def _download(url: str, dest: Path) -> None:
    """Stream a presigned GET to dest via a .part file, then atomic rename."""
    import requests

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    last_exc: Exception | None = None
    for attempt in range(DOWNLOAD_RETRIES):
        try:
            with requests.get(url, stream=True, timeout=120) as resp:
                if resp.status_code == 403:
                    raise _ExpiredPresign()  # caller re-presigns
                resp.raise_for_status()
                with part.open("wb") as handle:
                    for chunk in resp.iter_content(chunk_size=DOWNLOAD_CHUNK):
                        if chunk:
                            handle.write(chunk)
            if part.stat().st_size == 0:
                raise IOError(f"downloaded 0 bytes for {dest.name}")
            os.replace(part, dest)
            return
        except _ExpiredPresign:
            raise
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            time.sleep(2 ** attempt)
    if part.exists():
        try:
            part.unlink()
        except OSError:
            pass
    raise last_exc if last_exc else IOError(f"failed to download {dest.name}")


class _ExpiredPresign(Exception):
    """Signal to the caller that the presigned URL expired (HTTP 403)."""


# --- the Modal function ------------------------------------------------------
@app.function(
    cpu=2,
    memory=2048,
    timeout=60 * 60,
    volumes={str(DATA_ROOT): data_volume},
    secrets=[modal.Secret.from_name("alterego-relay")],
)
def ingest_from_r2(
    speaker: str,
    manifest_only: bool = False,
    force: bool = False,
    limit: int | None = None,
) -> dict:
    """Ingest a speaker's uploaded clips from R2 into the data volume.

    Writes /data/<speaker>/{manifest.csv, clips/*.mp4} so the existing
    ``prepare``/``train`` jobs consume them unchanged. Idempotent.
    """
    speaker = _safe_name(speaker)
    dataset_root = DATA_ROOT / speaker
    clips_dir = dataset_root / "clips"
    manifest_path = dataset_root / "manifest.csv"

    export = _export(speaker)
    examples = [e for e in export.get("examples", []) if e.get("clip_id")]
    prompt_rev = export.get("prompt_rev")

    splits = {"train": 0, "val": 0, "test": 0}
    for e in examples:
        splits[e["split"]] = splits.get(e["split"], 0) + 1

    if not examples:
        return {
            "speaker": speaker,
            "dataset_name": speaker,
            "examples_total": 0,
            "downloaded": 0,
            "skipped_existing": 0,
            "failed": [],
            "splits": splits,
            "manifest_path": str(manifest_path),
            "prompt_rev": prompt_rev,
        }

    if limit is not None:
        examples = examples[:limit]

    # Idempotency: which clips already exist on the volume?
    existing: set[str] = set()
    if clips_dir.is_dir() and not force:
        existing = {p.stem for p in clips_dir.glob("*.mp4")}

    to_fetch = [e for e in examples if _safe_component(e["clip_id"]) not in existing]

    failed: list[dict] = []
    downloaded = 0

    if not manifest_only:
        import requests

        remaining = list(to_fetch)
        # Batch presign just-in-time; re-presign any 403s once.
        while remaining:
            batch, remaining = remaining[:PRESIGN_BATCH], remaining[PRESIGN_BATCH:]
            ids = [_safe_component(e["clip_id"]) for e in batch]
            try:
                urls = _presign(speaker, [e["clip_id"] for e in batch])
            except Exception as exc:  # noqa: BLE001
                for e in batch:
                    failed.append({"clip_id": e["clip_id"], "error": f"presign: {exc!r}"})
                continue

            need_represign: list[dict] = []
            for e in batch:
                cid = _safe_component(e["clip_id"])
                url = urls.get(e["clip_id"])
                if not url:
                    failed.append({"clip_id": e["clip_id"], "error": "no presigned url returned"})
                    continue
                dest = clips_dir / f"{cid}.mp4"
                try:
                    _download(url, dest)
                    downloaded += 1
                except _ExpiredPresign:
                    need_represign.append(e)
                except Exception as exc:  # noqa: BLE001
                    failed.append({"clip_id": e["clip_id"], "error": f"download: {exc!r}"})

            if need_represign:
                try:
                    urls2 = _presign(speaker, [e["clip_id"] for e in need_represign])
                except Exception as exc:  # noqa: BLE001
                    for e in need_represign:
                        failed.append({"clip_id": e["clip_id"], "error": f"re-presign: {exc!r}"})
                    continue
                for e in need_represign:
                    cid = _safe_component(e["clip_id"])
                    url = urls2.get(e["clip_id"])
                    dest = clips_dir / f"{cid}.mp4"
                    if not url:
                        failed.append({"clip_id": e["clip_id"], "error": "no re-presigned url"})
                        continue
                    try:
                        _download(url, dest)
                        downloaded += 1
                    except Exception as exc:  # noqa: BLE001
                        failed.append({"clip_id": e["clip_id"], "error": f"download(retry): {exc!r}"})

    # Always (re)write the manifest from the latest export.
    write_manifest(manifest_path, examples)

    data_volume.commit()

    return {
        "speaker": speaker,
        "dataset_name": speaker,
        "examples_total": len(examples),
        "downloaded": downloaded,
        "skipped_existing": len(to_fetch) - downloaded if not manifest_only else 0,
        "failed": failed,
        "splits": splits,
        "manifest_path": str(manifest_path),
        "prompt_rev": prompt_rev,
        "splits_policy": export.get("splits_policy", "by-session"),
    }
