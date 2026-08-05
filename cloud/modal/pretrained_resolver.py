"""Resolve a ``--pretrained-model`` selector to a local checkpoint path.

Runs inside the Modal train container (the repo is mounted at REMOTE_PROJECT).
Returns either a local file path, or ``None`` for "default" (which lets
``train_personal.py`` fall back to the pinned, checksum-verified Auto-AVSR
checkpoint via ``open_altergo_engine.model_assets``).

Supported selectors:
  default                         -> None  (pinned aaahmet Auto-AVSR base)
  lrs3-visual-only                -> simonlesaumon/lrs3-lipreader-visual-only,
                                     but only once pretraining/.../source.json
                                     is pinned (revision + checksums); errors
                                     cleanly with the pin procedure otherwise.
  hf:<repo>[@<rev>]:<filename>    -> huggingface_hub download -> path
  r2:<object-key>                 -> relay POST /v1/presign -> presigned GET
                                     -> download to /cache/pretrained -> path
  <local-path>                    -> the path itself (must exist)

This module deliberately keeps ``training/`` free of relay/HF concerns: the
selector→path mapping is a Modal-integration concern, and ``train_personal.py``
keeps taking a concrete ``--pretrained-model-path``.
"""

import json
import os
import shutil
import urllib.request
from pathlib import Path

PRETRAINED_CACHE = Path("/cache/pretrained")


def _repo_root() -> Path:
    # cloud/modal/pretrained_resolver.py -> repo root
    return Path(__file__).resolve().parents[2]


def _resolve_default() -> None:
    return None


def _resolve_alias_lrs3() -> str:
    source_path = _repo_root() / "pretraining" / "lrs3-lipreader-visual-only" / "source.json"
    source = json.loads(source_path.read_text(encoding="utf-8"))
    revision = source.get("revision")
    files = source.get("expected_files", {}) or {}
    # Pick the first expected file with a pinned checksum (the promotion gate).
    pinned_file = next(
        (name for name, spec in files.items() if spec and spec.get("sha256")),
        None,
    )
    if not revision or not pinned_file:
        raise RuntimeError(
            "lrs3-visual-only is not pinned yet (revision/checksums unresolved in "
            f"{source_path}). Pin it first:\n"
            "  bash pretraining/lrs3-lipreader-visual-only/download.sh <40-char-hf-commit>\n"
            "then fill `revision` + `expected_files[*].sha256/size` in source.json and "
            "verify compatibility before use. See docs/pretrained-models.md."
        )
    return _resolve_hf(f"{source['repository_id']}@{revision}:{pinned_file}")


def _resolve_hf(spec: str) -> str:
    from huggingface_hub import hf_hub_download  # present in the train image

    rest = spec[len("hf:"):]
    repo_rev, filename = rest.rsplit(":", 1)
    rev = None
    if "@" in repo_rev:
        repo, rev = repo_rev.split("@", 1)
    else:
        repo = repo_rev
    PRETRAINED_CACHE.mkdir(parents=True, exist_ok=True)
    path = hf_hub_download(
        repo_id=repo,
        filename=filename,
        revision=rev,
        cache_dir=str(PRETRAINED_CACHE),
    )
    return str(path)


def _resolve_r2(key: str, relay_base: str, relay_token: str) -> str:
    if not relay_base or not relay_token:
        raise RuntimeError(
            "r2: pretrained source needs ALTEREGO_RELAY_BASE + ALTEREGO_RELAY_TOKEN "
            "(Modal secret 'alterego-relay')"
        )
    body = json.dumps({"keys": [key]}).encode("utf-8")
    req = urllib.request.Request(
        f"{relay_base.rstrip('/')}/v1/presign",
        data=body,
        headers={
            "Authorization": f"Bearer {relay_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        urls = json.loads(resp.read().decode("utf-8")).get("urls", {})
    url = urls.get(key)
    if not url:
        raise RuntimeError(f"relay did not return a presigned GET for r2 key {key!r}")
    dest = PRETRAINED_CACHE / Path(key).name
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=600) as resp, dest.open("wb") as out:
        shutil.copyfileobj(resp, out, length=8 * 1024 * 1024)
    return str(dest)


def resolve_pretrained_model(
    spec: str,
    *,
    relay_base: str | None = None,
    relay_token: str | None = None,
) -> str | None:
    if spec is None or spec == "default":
        return _resolve_default()
    if spec == "lrs3-visual-only":
        return _resolve_alias_lrs3()
    if spec.startswith("hf:"):
        return _resolve_hf(spec)
    if spec.startswith("r2:"):
        return _resolve_r2(spec[len("r2:"):], relay_base or "", relay_token or "")
    # Bare path: must already exist in the container.
    resolved = Path(spec).expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Pretrained model path not found: {resolved}")
    return str(resolved)
