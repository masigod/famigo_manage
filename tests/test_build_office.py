"""build_office.py 회귀 테스트 — 합성 픽스처(tests/fixtures/briefs) 기준.

실행: python3 -m unittest discover -s tests
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "office" / "build_office.py"
FIXTURE = ROOT / "tests" / "fixtures" / "briefs"
NOW = "2026-09-27T08:00:00+09:00"


def run(*args):
    return subprocess.run([sys.executable, str(BUILDER), *args], capture_output=True, text=True)


class BuildOfficeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        out = cls.tmp / "office.json"
        r = run("--data-dir", str(FIXTURE / "data"), "--config", "/nonexistent", "--out", str(out), "--now", NOW)
        assert r.returncode == 0, r.stderr
        cls.raw = out.read_text(encoding="utf-8")
        cls.office = json.loads(cls.raw)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def test_local_only_layers_never_leave(self):
        # L2·L3, 원문 필드, 목록형 일일 필드는 산출물 어디에도 없어야 한다.
        for needle in ("SHOULD-NEVER-APPEAR", "should", "L2", "L3"):
            self.assertNotIn(needle, self.raw)

    def test_bot_rooms_and_their_todos_excluded(self):
        self.assertNotIn("알림 봇", self.raw)
        self.assertNotIn("T006", [t["id"] for t in self.office["boards"]["ledger"]])

    def test_todos_count_keys_not_rows(self):
        ledger = {t["id"]: t for t in self.office["boards"]["ledger"]}
        self.assertEqual(len(ledger), len(self.office["boards"]["ledger"]))
        self.assertEqual(ledger["T002"]["status"], "done")  # 뒤 행(resolved)이 앞 행을 덮는다
        self.assertEqual(ledger["T002"]["title"], "가상 방 접두사 정리")  # 앞 행의 제목은 남는다

    def test_status_mapping(self):
        ledger = {t["id"]: t for t in self.office["boards"]["ledger"]}
        self.assertEqual(ledger["T001"]["status"], "review")  # decision → 사람 결정 대기
        self.assertEqual(ledger["T004"]["status"], "blocked")
        self.assertEqual(ledger["T005"]["status"], "archived")  # closed_wrong 은 지우지 않고 보관
        self.assertTrue(ledger["T001"]["stale"])
        self.assertFalse(ledger["T002"]["stale"])

    def test_assignee_resolved_through_aliases_only(self):
        ledger = {t["id"]: t for t in self.office["boards"]["ledger"]}
        self.assertEqual(ledger["T001"]["assignee"], "alpha-kim")  # 별칭 "Alpha"
        self.assertIsNone(ledger["T004"]["assignee"])  # 기록 없으면 추측하지 않는다

    def test_inactive_member_excluded_and_syn_added(self):
        names = [m["display_name"] for m in self.office["members"]]
        self.assertNotIn("Delta Park", names)
        self.assertIn("Syn", names)
        for m in self.office["members"]:
            self.assertRegex(m["key"], r"^[A-Za-z0-9._-]+$")

    def test_pipeline_and_zombie(self):
        pipe = {p["title"]: p for p in self.office["boards"]["pipeline"]}
        self.assertEqual(pipe["가상 캠페인 B"]["status"], "scheduled")
        self.assertTrue(pipe["가상 캠페인 B"]["zombie"])
        self.assertEqual(pipe["가상 캠페인 D"]["status"], "archived")
        self.assertIsNone(pipe["가상 캠페인 D"]["quiet_days"])  # 미확인은 0 이 아니다
        self.assertFalse(pipe["가상 캠페인 D"]["zombie"])
        self.assertEqual(pipe["가상 캠페인 E"]["stage_note"], "정산중_9/9")
        self.assertEqual([h["room"] for h in self.office["hygiene"]], ["가상 캠페인 B"])

    def test_gate_applied(self):
        self.assertEqual(self.office["gate"], "lark_store.export_for_slack")


class GateFailClosedTest(unittest.TestCase):
    def test_missing_gate_stops(self):
        with tempfile.TemporaryDirectory() as d:
            data = Path(d) / "data"
            shutil.copytree(FIXTURE / "data", data)  # tools/ 없이
            r = run("--data-dir", str(data), "--out", str(Path(d) / "o.json"))
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertFalse((Path(d) / "o.json").exists())

    def test_bad_gate_return_stops(self):
        with tempfile.TemporaryDirectory() as d:
            shutil.copytree(FIXTURE / "data", Path(d) / "data")
            (Path(d) / "tools").mkdir()
            (Path(d) / "tools" / "lark_store.py").write_text("def export_for_slack(p):\n    return 'text'\n")
            r = run("--data-dir", str(Path(d) / "data"), "--out", str(Path(d) / "o.json"))
            self.assertEqual(r.returncode, 3, r.stderr)


class ImplicitInputTest(unittest.TestCase):
    def test_cwd_roster_and_config_are_never_read_implicitly(self):
        # 회귀: 기본값 out/lark_roster.json 이 실행 위치의 실명 명단을 픽스처 빌드에 섞었다.
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "out").mkdir()
            (Path(d) / "config").mkdir()
            leak = {"members": [{"id": "x", "name": "CWD-ROSTER-LEAK", "rooms": []}], "rooms": []}
            (Path(d) / "out" / "lark_roster.json").write_text(json.dumps(leak), encoding="utf-8")
            (Path(d) / "config" / "office.config.json").write_text(json.dumps({"org_name": "CWD-CONFIG-LEAK"}), encoding="utf-8")
            out = Path(d) / "o.json"
            r = subprocess.run(
                [sys.executable, str(BUILDER), "--data-dir", str(FIXTURE / "data"), "--out", str(out), "--now", NOW],
                capture_output=True, text=True, cwd=d,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            raw = out.read_text(encoding="utf-8")
            self.assertNotIn("CWD-ROSTER-LEAK", raw)
            self.assertNotIn("CWD-CONFIG-LEAK", raw)


if __name__ == "__main__":
    unittest.main()
