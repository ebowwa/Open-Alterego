# Personalization data coverage plan

How to collect a personalization dataset that produces a *usable* personalized
lip-reading model, not just a large one. Coverage is enforced by the prompt
generator (`cloud/relay/prompts/generate.ts`) and tracked by the collect relay.

## Goal

Personalization adapts the pretrained Auto-AVSR model to one speaker's mouth
and to the **deployment conditions**. Three independent axes must all be
covered:

1. **Linguistic** — every visible mouth shape (viseme), confusable contrasts,
   digits, and the target vocabulary, in varied contexts.
2. **Environmental** — the lighting, places, and cameras the model will
   actually meet at deployment.
3. **Splits** — held-out *unseen* sentences and a separate environment, so WER
   is an honest measure of generalization.

Deployment assumption: **silent assistant input + general dictation**, iPhone
front camera (glasses/secondary camera optional). Target size: **~750 prompts
across 4–5 environments** ("Solid").

## 1. Linguistic coverage

The generator guarantees each viseme group has dedicated contrastive sentences
(minimal pairs — exactly where lip-reading fails) before any vocabulary fill.

| Viseme group | Phonemes | Example contrasts |
| --- | --- | --- |
| Bilabial | p b m | pat bat mat · pin bin mint |
| Labiodental | f v | fan van · safe save |
| Dental | θ ð | think that · bath bathe |
| Alveolar | t d n l s z | ten den men · light night |
| Postalveolar | ʃ tʃ dʒ | ship chip · wash watch |
| R / L | r l | ray lay · grass glass |
| Velar/glottal (low-vis) | k ɡ h ŋ | cap gap · call hall |
| Front vowels | i ɪ eɪ ɛ æ | beat bit bait bet bat |
| Back/rounded vowels | ɑ ɔ oʊ ʊ u ʌ | cot caught coat cut |
| Diphthongs | aɪ aʊ ɔɪ | right out toy |

Current set (`prompts/rev2026-07-25.json`, 750): every group ≥ 10 dedicated
sentences, 31 digit sentences, 85 curated general + 514 assistant
(curated + grammatical verb/object/place templates), ~650 unique words,
lengths 2–10 words.

Vocabulary is **hybrid**:
- **Assistant**: action verbs (set/send/call/play/open/remind/turn/find/share/
  start/pause/…) × objects (timer/alarm/message/meeting/light/photo/music/…)
  × names × times × places.
- **General/dictation**: everyday + work sentences + classic articulatory
  sentences ("she sells sea shells…", "unique new york") for coarticulation.

To regenerate or retune: `bun cloud/relay/prompts/generate.ts --count 750
--rev <date>` (prints a coverage report). Bump `--rev` when the set changes.

## 2. Environmental coverage — the session matrix

Each **session = one environment** (and is also the split unit). Record on
**different days** to avoid single-sitting overfit. Keep the face centered and
the mouth unobstructed; vary head pose/distance slightly within a session.

| Session | Place | Lighting | Device | Background | Split |
| --- | --- | --- | --- | --- | --- |
| s01 | home desk (day) | daylight, side | iPhone front | plain wall | train |
| s02 | home desk (eve) | warm lamp, low | iPhone front | plain wall | train |
| s03 | living room | mixed, soft | iPhone front | cluttered | val |
| s04 | outdoors | overcast / bright | iPhone front | varied | test |
| s05 | other room / Mac | different | Mac webcam (if used) | — | train |

If glasses or a second camera is a real deployment target, dedicate a session
to each device so the model generalizes across cameras.

## 3. Speaker state

- **Primary: silent mouthing** — match deployment (it's a *silent*-speech
  model). Voiced takes are optional robustness data, not the main course.
- Vary **rate**: normal, slightly fast, slow. Keep expression natural.

## 4. Splits and evaluation

- Splits are **owned by the relay** and assigned **by session** (see
  `cloud/relay/src/splits.ts`; default `s01:train s02:val s03:test`, unknown →
  train; override via `SPLIT_SESSION_MAP`). Sentences are **disjoint** across
  splits.
- A 4–5 session layout gives a held-out **test environment** (s04) whose
  sentences were never trained → honest WER.
- Report raw visual-only WER on the held-out set before any LLM-correction
  layer (per README "Status and provenance").

## 5. Quality control (the silent killer of quality)

- **Transcript must equal what you mouthed.** A mismatch teaches the wrong
  mapping. Flub a take → retake or delete; never upload a wrong one.
- Reject occluded/off-frame takes (mediapipe will skip them anyway).
- `prepare` strips audio + re-encodes 25 fps + crops 96×96 mouth — your job is
  clear framing + correct text.

## 6. Recording schedule (executable)

1. Pull the prompt list: `GET /v1/collect/prompts` (750, rev-tagged).
2. Per session (~150 prompts each, sentences disjoint across sessions):
   set up the environment from the matrix, sit, and read each prompt once
   silently. Allow retakes; delete bad ones.
3. Upload each clip paired with its `prompt_id` + `prompt_rev` + `session`
   (the relay assigns split + records metadata). `GET /v1/collect/status`
   shows per-split / per-session completeness.
4. When all sessions are uploaded: `modal run cloud/modal/ingest.py::ingest_from_r2 --speaker <name>`
   → `modal run cloud/modal/app.py::prepare --dataset-name <name>` →
   `::train --run-name <name>-v1` → download → infer → report WER.

## Coverage gaps to watch

- Viseme groups with few dedicated sentences (vowel_front/back, diphthongs) —
  add more if WER on those sounds is poor.
- Function words dominate frequency ("the", "to", "i") — expected; ensure
  content/assistant vocabulary is also well-represented.
- If deployment expands to a new device or lighting, record a new session
  there before trusting the model in it.
