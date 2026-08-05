import csv
import tempfile
import unittest
from pathlib import Path

from cloud.modal.ingest import write_manifest, _safe_name, _safe_component
from training.prepare_dataset import _load_manifest
from training.prepare_dataset import _safe_component as prepare_safe_component


class TestSanitizers(unittest.TestCase):
    def test_safe_name_accepts_valid(self):
        for ok in ["elijah", "elijah-v1", "a1.b-c", "smoke"]:
            self.assertEqual(_safe_name(ok), ok)

    def test_safe_name_rejects_invalid(self):
        for bad in ["", "elijah v1", "_x", "-y", "elij@h", "1 thing"]:
            with self.assertRaises(ValueError):
                _safe_name(bad)

    def test_component_matches_prepare_exactly(self):
        # ingest's id sanitizer must equal prepare_dataset's so the ids we write
        # into manifest.csv are identical to what prepare would (re-)sanitize
        # them into downstream — no drift, no duplicate-id collisions.
        for raw in ["s01-p0001-abc", "elijah", "a.b.c", "foo bar baz", "...x...", "café", "a/b\\c"]:
            self.assertEqual(_safe_component(raw), prepare_safe_component(raw, "id"))


class TestWriteManifest(unittest.TestCase):
    def _examples(self):
        return [
            {"clip_id": "s01-p0001-aaa", "text": "hey there", "split": "train"},
            {"clip_id": "s02-p0002-bbb", "text": "what is up", "split": "val"},
            {"clip_id": "s03-p0003-ccc", "text": "see you", "split": "test"},
        ]

    def test_prepare_loader_accepts_it(self):
        examples = self._examples()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            clips = root / "clips"
            clips.mkdir()
            for ex in examples:
                (clips / f"{ex['clip_id']}.mp4").write_bytes(b"x")
            manifest = root / "manifest.csv"
            write_manifest(manifest, examples)
            rows = _load_manifest(manifest)  # raises if columns wrong
            self.assertEqual(len(rows), 3)

    def test_header_and_shape(self):
        examples = self._examples()
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d) / "manifest.csv"
            write_manifest(manifest, examples)
            with manifest.open(newline="") as h:
                header = next(csv.reader(h))
            self.assertEqual(header, ["id", "video", "text", "split"])

    def test_id_equals_video_stem_and_splits_valid(self):
        examples = self._examples()
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d) / "manifest.csv"
            write_manifest(manifest, examples)
            rows = _load_manifest(manifest)
            self.assertEqual(len(rows), len({r["id"] for r in rows}))  # no dup ids
            for r in rows:
                self.assertEqual(Path(r["video"]).name, f"{r['id']}.mp4")
                self.assertEqual(r["video"], f"clips/{r['id']}.mp4")
                self.assertIn(r["split"], {"train", "val", "test"})

    def test_sorted_train_val_test(self):
        examples = list(reversed(self._examples()))  # pass in random order
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d) / "manifest.csv"
            write_manifest(manifest, examples)
            rows = _load_manifest(manifest)
            self.assertEqual([r["split"] for r in rows], ["train", "val", "test"])

    def test_text_whitespace_collapsed(self):
        examples = [{"clip_id": "x1", "text": "  hello   world  ", "split": "train"}]
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d) / "manifest.csv"
            write_manifest(manifest, examples)
            self.assertEqual(_load_manifest(manifest)[0]["text"], "hello world")

    def test_idempotent_rewrite(self):
        examples = [{"clip_id": "x1", "text": "a", "split": "train"}]
        with tempfile.TemporaryDirectory() as d:
            manifest = Path(d) / "manifest.csv"
            write_manifest(manifest, examples)
            first = manifest.read_text()
            write_manifest(manifest, examples)
            self.assertEqual(manifest.read_text(), first)


if __name__ == "__main__":
    unittest.main()
