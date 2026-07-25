"""Modal jobs for preprocessing and personalized Auto-AVSR fine-tuning."""

import json
import re
import subprocess
import sys
from pathlib import Path

import modal


APP_NAME = "silent-lip-reader-finetune"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
REMOTE_PROJECT = Path("/root/open-altergo")
DATA_ROOT = Path("/data")
RUNS_ROOT = Path("/runs")

DATA_VOLUME_NAME = "silent-lip-reader-data"
RUNS_VOLUME_NAME = "silent-lip-reader-runs"
HF_VOLUME_NAME = "silent-lip-reader-hf-cache"

data_volume = modal.Volume.from_name(DATA_VOLUME_NAME, create_if_missing=True)
runs_volume = modal.Volume.from_name(RUNS_VOLUME_NAME, create_if_missing=True)
hf_volume = modal.Volume.from_name(HF_VOLUME_NAME, create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .uv_pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        "torchaudio==2.6.0",
        "pytorch-lightning==2.6.5",
        "mediapipe==0.10.21",
        "opencv-contrib-python==4.10.0.84",
        "numpy<2",
        "Pillow",
        "sentencepiece",
        "scikit-image",
        "av==12.3.0",
        "huggingface-hub>=0.33.5,<2",
    )
    .env(
        {
            "HF_HOME": "/cache/huggingface",
            "PYTHONUNBUFFERED": "1",
        }
    )
    .add_local_dir(
        PROJECT_ROOT,
        remote_path=str(REMOTE_PROJECT),
        copy=True,
        ignore=[
            ".git",
            ".venv",
            "**/__pycache__",
            "**/*.pyc",
            "datasets",
            "runs",
            "models",
        ],
    )
    # The prepare/train subprocesses import the engine package
    # (open_altergo_engine.datamodule, .model_assets, .lightning, .preparation),
    # so install it from the copied source. pip_install only accepts package
    # specifiers; install from the in-image path with run_commands.
    .run_commands(f"pip install {REMOTE_PROJECT / 'cloud' / 'engine'}")
)

app = modal.App(APP_NAME, image=image)


def _safe_name(value, field):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise ValueError(
            f"{field} must start with an alphanumeric character and contain only "
            "letters, numbers, dots, underscores, or hyphens"
        )
    return value


@app.function(
    cpu=4,
    memory=8192,
    timeout=4 * 60 * 60,
    volumes={
        str(DATA_ROOT): data_volume,
        "/cache/huggingface": hf_volume,
    },
)
def prepare(
    dataset_name: str,
    manifest: str = "manifest.csv",
    flip: bool = False,
    max_seconds: float = 16.0,
):
    """Preprocess an uploaded prompted-video dataset on Modal CPU workers."""

    dataset_name = _safe_name(dataset_name, "dataset_name")
    dataset_root = DATA_ROOT / dataset_name
    manifest_path = dataset_root / manifest
    output_dir = dataset_root / "processed"
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"Upload the dataset first; manifest not found at {manifest_path}"
        )

    command = [
        sys.executable,
        str(REMOTE_PROJECT / "training" / "prepare_dataset.py"),
        "--manifest",
        str(manifest_path),
        "--output-dir",
        str(output_dir),
        "--dataset-name",
        dataset_name,
        "--max-seconds",
        str(max_seconds),
    ]
    if flip:
        command.append("--flip")
    subprocess.run(command, cwd=REMOTE_PROJECT, check=True)
    data_volume.commit()
    hf_volume.commit()
    return json.loads((output_dir / "summary.json").read_text(encoding="utf-8"))


@app.function(
    gpu="A10",
    cpu=8,
    memory=32768,
    timeout=24 * 60 * 60,
    retries=modal.Retries(initial_delay=10.0, max_retries=3),
    single_use_containers=True,
    volumes={
        str(DATA_ROOT): data_volume,
        str(RUNS_ROOT): runs_volume,
        "/cache/huggingface": hf_volume,
    },
)
def train(
    dataset_name: str,
    run_name: str,
    max_epochs: int = 30,
    learning_rate: float = 2e-5,
    strategy: str = "encoder-decoder",
    unfreeze_encoder_layers: int = 2,
    resume: bool = True,
):
    """Run resumable, single-speaker fine-tuning on one Modal A10 GPU."""

    dataset_name = _safe_name(dataset_name, "dataset_name")
    run_name = _safe_name(run_name, "run_name")
    processed = DATA_ROOT / dataset_name / "processed"
    output_dir = RUNS_ROOT / run_name
    train_file = f"{dataset_name}_train.csv"
    val_file = f"{dataset_name}_val.csv"
    test_file = f"{dataset_name}_test.csv"

    for required in (train_file, val_file):
        path = processed / "labels" / required
        if not path.is_file():
            raise FileNotFoundError(
                f"Missing {path}; run the Modal prepare function first"
            )

    output_dir.mkdir(parents=True, exist_ok=True)
    existing = list(output_dir.iterdir())
    last_checkpoint = output_dir / "last.ckpt"
    if existing and not resume:
        raise FileExistsError(
            f"Run directory {output_dir} is not empty; choose another run name "
            "or enable resume"
        )

    command = [
        sys.executable,
        str(REMOTE_PROJECT / "training" / "train_personal.py"),
        "--root-dir",
        str(processed),
        "--output-dir",
        str(output_dir),
        "--train-file",
        train_file,
        "--val-file",
        val_file,
        "--max-epochs",
        str(max_epochs),
        "--lr",
        str(learning_rate),
        "--finetune-strategy",
        strategy,
        "--unfreeze-encoder-layers",
        str(unfreeze_encoder_layers),
    ]
    if (processed / "labels" / test_file).is_file():
        command.extend(["--test-file", test_file])
    if resume and last_checkpoint.is_file():
        command.extend(["--resume-from", str(last_checkpoint)])

    subprocess.run(command, cwd=REMOTE_PROJECT, check=True)
    runs_volume.commit()
    hf_volume.commit()
    return json.loads((output_dir / "run.json").read_text(encoding="utf-8"))
