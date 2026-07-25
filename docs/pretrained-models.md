# Pretrained model bases

The personalization pipeline fine-tunes **from a pretrained base**. This doc
lists the bases available to `--pretrained-model`, their status, and the
evidence on which one to choose. Sources: `cloud/engine/src/model_manifest.json`,
`pretraining/`, and `docs/RESEARCH_LOG.md`.

## The selector

`modal run cloud/modal/app.py::train` (and `::evaluate`) accept:

```
--pretrained-model default                  # pinned Auto-AVSR base (default)
--pretrained-model lrs3-visual-only         # alias; errors until pinned (see below)
--pretrained-model hf:<repo>[@<rev>]:<file> # any Hugging Face checkpoint
--pretrained-model r2:<object-key>          # any object in the collect R2 bucket
--pretrained-model /path/to/state_dict.pt   # a file already in the container
```

For non-native checkpoint layouts, add `--transfer-frontend` or
`--transfer-encoder` (passed through to the loader in
`cloud/engine/src/lightning.py`).

## Active base

| Selector | Source | Format | Status |
| --- | --- | --- | --- |
| `default` | `aaahmet/silent-lip-reader-model` (mirror of `AD1TEYA/lip-reading-model`) | Auto-AVSR E2E `state_dict`, ~1 GB, native key layout | **Pinned + SHA-256 verified** in `model_manifest.json`. ~19% WER on clean LRS3 — near-SOTA English VSR. |

`default` returns `None` from the resolver, so `train_personal.py` downloads the
pinned base through `open_altergo_engine.model_assets` (checksum-verified) into
the HF cache volume. This is the recommended base.

## Candidate bases (not yet active)

| Selector / source | What | Status |
| --- | --- | --- |
| `lrs3-visual-only` — `simonlesaumon/lrs3-lipreader-visual-only` | English visual-only Auto-AVSR, 250M, `model_avg_10.pth` | `pretraining/.../source.json` has `revision: null`, checksums null → **unpinned**. The alias fails closed with the pin procedure until resolved. CC-BY-NC-4.0 (research only). |
| `VSRo-200` — Romanian sentence VSR | LRRo transfer heads | `pretraining/vsro200/`. Research/robustness only, not an English backend. |

To activate `lrs3-visual-only`: pin the immutable HF revision + checksums via
`pretraining/lrs3-lipreader-visual-only/download.sh <40-char-commit>`, fill
`source.json` (`revision`, `expected_files[*].sha256/size`), then run a
compatibility test (does it `load_state_dict` natively, or need
`--transfer-encoder`?) and a held-out WER vs `default`.

## Alternative models evaluated or considered (from the research log)

| Model | Verdict |
| --- | --- |
| Stronger same-arch auto_avsr (LRW+LRS2+LRS3+Vox2+AVSpeech, ~3000h) | **Evaluated: 0.584 vs 0.547 — NOT better.** "Swapping same-arch checkpoints is not the lever." |
| VSP-LLM / Llama-AVSR (VSR-LLM, different arch) | Pure-VSR WER ~26% (worse); "not worth the GPU hours." A real jump would need this different architecture — bigger integration (new decoder/inference path). |
| Chaplin's checkpoint | Listed "to try"; not evaluated. |
| AV-HuBERT | Ruled out — uses audio, not pure lip-read. |
| VALLR (18.7% LRS3) | Best published 2025; not integrated. Different architecture. |

## Which base to choose

The research log's conclusion (Phase 3/4, F5): the active base is **already near
the architecture's out-of-domain ceiling** — a stronger same-arch checkpoint was
tested and did not help. The two real accuracy levers are:

1. **Recording conditions** — clean, frontal, well-lit footage gives ~5–10% WER
   even on an unseen speaker (see `docs/data-coverage.md`).
2. **Per-speaker personalization** — exactly what this pipeline does.

So: **start from `default`**, invest in coverage + personalization, and only A/B
another base if you have a *different-architecture* checkpoint (e.g. a VSR-LLM)
in hand. Same-arch swaps are expected to be neutral-to-worse.

## A/B recipe

```bash
# personalized WER for each base (writes test.wer into run.json)
modal run cloud/modal/app.py::train --dataset-name elijah --run-name elijah-default  --pretrained-model default
modal run cloud/modal/app.py::train --dataset-name elijah --run-name elijah-lrs3    --pretrained-model hf:simonlesaumon/lrs3-lipreader-visual-only@<rev>:model_avg_10.pth --transfer-encoder

# base (unpersonalized) WER on the same held-out test split, for reference
modal run cloud/modal/app.py::evaluate --dataset-name elijah                            # base default
modal run cloud/modal/app.py::evaluate --dataset-name elijah --run-name elijah-default  # personalized
```

Compare `runs/<name>/run.json` → `test[0].wer` across runs; lower is better.
Report raw visual-only WER before any LLM-correction layer.
