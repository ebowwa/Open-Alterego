import tempfile
import unittest
from pathlib import Path

from cloud.modal.pretrained_resolver import resolve_pretrained_model


class TestResolveDefault(unittest.TestCase):
    def test_default_returns_none(self):
        self.assertIsNone(resolve_pretrained_model("default"))

    def test_none_returns_none(self):
        self.assertIsNone(resolve_pretrained_model(None))


class TestResolvePath(unittest.TestCase):
    def test_existing_path_returned(self):
        with tempfile.NamedTemporaryFile(suffix=".pt") as handle:
            # resolve() may differ from the raw name on macOS (/var -> /private/var)
            self.assertEqual(
                Path(resolve_pretrained_model(handle.name)).resolve(),
                Path(handle.name).resolve(),
            )

    def test_missing_path_raises(self):
        with self.assertRaises(FileNotFoundError):
            resolve_pretrained_model("/nonexistent/does-not-exist.pt")


class TestResolveAlias(unittest.TestCase):
    def test_lrs3_unpinned_raises_with_instructions(self):
        # source.json currently has revision: null (not pinned), so the alias
        # must fail closed with the pin procedure, not silently load.
        with self.assertRaises(RuntimeError) as ctx:
            resolve_pretrained_model("lrs3-visual-only")
        self.assertIn("pin", str(ctx.exception).lower())


class TestResolveR2(unittest.TestCase):
    def test_r2_without_relay_creds_raises(self):
        with self.assertRaises(RuntimeError) as ctx:
            resolve_pretrained_model("r2:models/base.pt")
        self.assertIn("ALTEREGO_RELAY", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
