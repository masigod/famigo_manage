"""shape.py 는 구조만 내보낸다 — 값·이름이 새면 실패."""

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ShapeTest(unittest.TestCase):
    def test_no_values_leak(self):
        out = subprocess.run(
            [sys.executable, str(ROOT / "office" / "shape.py"), "--data-dir", str(ROOT / "tests/fixtures/briefs/data")],
            capture_output=True, text=True, check=True,
        ).stdout
        for value in ("p_alpha", "p_delta", "Alpha", "Bravo", "찰리", "가상", "SHOULD-NEVER", "운영 매니저", "oc_1", "T001", "2026-09-2", "2026-08-", "SHOULD-NOT-COPY"):
            self.assertNotIn(value, out)
        for key in ("L1", "chat_id", "last_seen", "owners", "str(date)", "<map: 4 keys>"):
            self.assertIn(key, out)


if __name__ == "__main__":
    unittest.main()
