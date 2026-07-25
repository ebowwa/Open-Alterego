"""Single-speaker Auto-AVSR fine-tuning entrypoint.

Designed to run both on a single local CUDA GPU and inside ``cloud/modal/app.py``.
The produced ``personalized_model.pt`` is a raw E2E state dict compatible with
``open_altergo_engine.local_infer`` and the ``LIPREAD_CKPT`` application setting.
"""

import argparse
import json
import os
from pathlib import Path

VALID_STRATEGIES = {"decoder", "encoder-decoder", "full"}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--train-file", required=True)
    parser.add_argument("--val-file", required=True)
    parser.add_argument("--test-file")
    parser.add_argument("--pretrained-model-path")
    parser.add_argument(
        "--transfer-frontend",
        action="store_true",
        help="load only frontend weights from a non-native checkpoint layout",
    )
    parser.add_argument(
        "--transfer-encoder",
        action="store_true",
        help="load frontend+proj_encoder+encoder from a checkpoint with those "
        "prefixes (e.g. an upstream auto_avsr encoder dump)",
    )
    parser.add_argument("--resume-from")
    parser.add_argument(
        "--finetune-strategy",
        choices=sorted(VALID_STRATEGIES),
        default="encoder-decoder",
    )
    parser.add_argument("--unfreeze-encoder-layers", type=int, default=2)
    parser.add_argument("--max-epochs", type=int, default=30)
    parser.add_argument("--warmup-epochs", type=int, default=1)
    parser.add_argument("--early-stopping-patience", type=int, default=5)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--ctc-weight", type=float, default=0.1)
    parser.add_argument("--max-frames", type=int, default=900)
    parser.add_argument("--train-num-buckets", type=int, default=50)
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--num-workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--precision", default="auto")
    return parser.parse_args(argv)


def _resolve_pretrained_checkpoint(path):
    if path:
        resolved = Path(path).expanduser().resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"Pretrained checkpoint not found: {resolved}")
        return str(resolved)

    from open_altergo_engine.model_assets import download_model_file

    return download_model_file("pytorch_model.pt")


def _validate_labels(root_dir, filenames):
    labels_dir = Path(root_dir) / "labels"
    for filename in filenames:
        if not filename:
            continue
        path = labels_dir / filename
        if not path.is_file():
            raise FileNotFoundError(f"Missing label file: {path}")
        if not path.read_text(encoding="utf-8").strip():
            raise ValueError(f"Label file is empty: {path}")


def _export_inference_state(checkpoint_path, destination):
    import torch

    payload = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    lightning_state = payload["state_dict"]
    state = {
        key.removeprefix("model."): value
        for key, value in lightning_state.items()
        if key.startswith("model.")
    }
    if not state:
        raise RuntimeError("Checkpoint did not contain an Auto-AVSR model state")
    torch.save(state, destination)


def train(args):
    import torch
    import pytorch_lightning as pl
    from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint
    from pytorch_lightning.loggers import CSVLogger
    from open_altergo_engine.datamodule.data_module import DataModule
    from personalization import PersonalizationModelModule

    pl.seed_everything(args.seed, workers=True)
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    _validate_labels(
        args.root_dir,
        [args.train_file, args.val_file, args.test_file],
    )
    args.modality = "video"
    args.pretrained_model_path = _resolve_pretrained_checkpoint(
        args.pretrained_model_path
    )
    args.decode_snr_target = 999999

    model = PersonalizationModelModule(args)
    counts = model.parameter_counts
    print(
        "Fine-tuning "
        f"{counts['trainable']:,}/{counts['total']:,} parameters "
        f"with strategy={args.finetune_strategy}"
    )

    data_module = DataModule(
        args,
        batch_size=args.batch_size,
        train_num_buckets=args.train_num_buckets,
        num_workers=args.num_workers,
    )
    checkpoint_callback = ModelCheckpoint(
        dirpath=output_dir,
        filename="{epoch:02d}-{loss_val:.4f}",
        monitor="loss_val",
        mode="min",
        save_top_k=3,
        save_last=True,
    )
    callbacks = [checkpoint_callback]
    if args.early_stopping_patience > 0:
        callbacks.append(
            EarlyStopping(
                monitor="loss_val",
                mode="min",
                patience=args.early_stopping_patience,
            )
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
        max_epochs=args.max_epochs,
        callbacks=callbacks,
        logger=CSVLogger(save_dir=str(output_dir), name="logs"),
        gradient_clip_val=10.0,
        log_every_n_steps=1,
        deterministic=False,
    )

    resume_from = args.resume_from
    if resume_from and not Path(resume_from).is_file():
        raise FileNotFoundError(f"Resume checkpoint not found: {resume_from}")
    trainer.fit(
        model=model,
        datamodule=data_module,
        ckpt_path=resume_from,
    )

    best_checkpoint = checkpoint_callback.best_model_path
    if not best_checkpoint:
        best_checkpoint = str(output_dir / "last.ckpt")
    inference_checkpoint = output_dir / "personalized_model.pt"
    _export_inference_state(best_checkpoint, inference_checkpoint)

    test_result = None
    if args.test_file:
        test_result = trainer.test(
            model=model,
            datamodule=data_module,
            ckpt_path=best_checkpoint,
        )

    metrics = {
        "best_checkpoint": best_checkpoint,
        "inference_checkpoint": str(inference_checkpoint),
        "parameters": counts,
        "strategy": args.finetune_strategy,
        "unfreeze_encoder_layers": args.unfreeze_encoder_layers,
        "test": test_result,
    }
    (output_dir / "run.json").write_text(
        json.dumps(metrics, indent=2, default=str),
        encoding="utf-8",
    )
    (output_dir / "arguments.json").write_text(
        json.dumps(vars(args), indent=2, default=str),
        encoding="utf-8",
    )
    print(json.dumps(metrics, indent=2, default=str))
    return metrics


if __name__ == "__main__":
    train(parse_args())
