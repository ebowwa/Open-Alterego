"""Score a checkpoint on a prepared dataset's held-out test split → WER.

Test-only sibling of ``train_personal.py``: loads a checkpoint (the pinned
default base, a personalized ``personalized_model.pt``, or any E2E state dict)
and runs the Auto-AVSR test path. Used for base-vs-personalized A/B on the
same test split (train already reports the personalized test WER in run.json).
"""

import argparse
import json
from pathlib import Path


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root-dir", required=True)
    parser.add_argument("--test-file", required=True)
    parser.add_argument(
        "--checkpoint",
        default="default",
        help='"default" downloads the pinned Auto-AVSR base; otherwise a path '
        "to an E2E state dict (e.g. runs/<name>/personalized_model.pt)",
    )
    parser.add_argument("--transfer-frontend", action="store_true")
    parser.add_argument("--transfer-encoder", action="store_true")
    parser.add_argument("--ctc-weight", type=float, default=0.1)
    parser.add_argument("--max-frames", type=int, default=900)
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--num-workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--precision", default="auto")
    return parser.parse_args(argv)


def _resolve_checkpoint(value):
    if value and value != "default":
        resolved = Path(value).expanduser().resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"Checkpoint not found: {resolved}")
        return str(resolved)
    from open_altergo_engine.model_assets import download_model_file

    return download_model_file("pytorch_model.pt")


def evaluate(args):
    import torch
    import pytorch_lightning as pl
    from open_altergo_engine.datamodule.data_module import DataModule
    from open_altergo_engine.lightning import ModelModule

    pl.seed_everything(args.seed, workers=True)
    args.modality = "video"
    args.pretrained_model_path = _resolve_checkpoint(args.checkpoint)
    args.decode_snr_target = 999999

    model = ModelModule(args)
    data_module = DataModule(
        args,
        batch_size=args.batch_size,
        train_num_buckets=50,
        num_workers=args.num_workers,
    )

    using_cuda = torch.cuda.is_available()
    precision = args.precision
    if precision == "auto":
        precision = "16-mixed" if using_cuda else "32-true"

    trainer = pl.Trainer(
        accelerator="gpu" if using_cuda else "cpu",
        devices=1,
        strategy="auto",
        precision=precision,
        logger=False,
        enable_checkpointing=False,
        deterministic=False,
    )
    result = trainer.test(model=model, datamodule=data_module)
    payload = {
        "checkpoint": args.pretrained_model_path,
        "transfer_frontend": args.transfer_frontend,
        "transfer_encoder": args.transfer_encoder,
        "test": result,
    }
    out_path = Path(args.root_dir) / "eval_result.json"
    out_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    print(json.dumps(payload, indent=2, default=str))
    return payload


if __name__ == "__main__":
    evaluate(parse_args())
