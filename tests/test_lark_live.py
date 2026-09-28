"""lark_live.py (실시간 반영 데몬) 회귀 테스트 — SDK·네트워크 없이 판단 로직만.

실행: python3 -m unittest discover -s tests
"""

import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "office"))

import build_office  # noqa: E402
import lark_live  # noqa: E402

KST = lark_live.KST
FIXTURE = ROOT / "tests" / "fixtures" / "briefs"


def ms(y, m, d, h=10):
    return int(dt.datetime(y, m, d, h, tzinfo=KST).timestamp() * 1000)


class Untouchable:
    """본문(content)·발신자 ID 를 읽으면 실패한다 — 데몬이 이것들을 보지 않는다는 증명."""

    def __init__(self, **fields):
        self.__dict__.update(fields)

    @property
    def content(self):
        raise AssertionError("본문을 읽었다")

    @property
    def sender_id(self):
        raise AssertionError("발신자 ID 를 읽었다")

    @property
    def mentions(self):
        raise AssertionError("멘션을 읽었다")


def message_event(chat_type="group", sender_type="user", chat_id="oc_3", create_time="1790000000000"):
    msg = Untouchable(chat_id=chat_id, chat_type=chat_type, create_time=create_time)
    sender = Untouchable(sender_type=sender_type)
    return types.SimpleNamespace(event=types.SimpleNamespace(message=msg, sender=sender))


class MessageActivityTest(unittest.TestCase):
    def test_group_human_message_gives_room_and_time_only(self):
        self.assertEqual(lark_live.message_activity(message_event()), ("oc_3", 1790000000000))

    def test_dm_bot_and_malformed_are_ignored(self):
        self.assertIsNone(lark_live.message_activity(message_event(chat_type="p2p")))
        self.assertIsNone(lark_live.message_activity(message_event(sender_type="app")))
        self.assertIsNone(lark_live.message_activity(message_event(create_time="soon")))
        self.assertIsNone(lark_live.message_activity(message_event(chat_id="")))
        self.assertIsNone(lark_live.message_activity(types.SimpleNamespace(event=None)))


class ActivityStoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "out" / "lark_activity.json"

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_rebuild_only_when_the_day_changes(self):
        s = lark_live.ActivityStore(self.path)
        self.assertTrue(s.note("oc_1", ms(2026, 9, 27, 9)))  # 처음 본 방
        self.assertFalse(s.note("oc_1", ms(2026, 9, 27, 15)))  # 같은 날 — 조용한 기간이 안 바뀐다
        self.assertFalse(s.note("oc_1", ms(2026, 9, 26)))  # 과거 시각은 무시
        self.assertTrue(s.note("oc_1", ms(2026, 9, 28, 1)))  # 다음 날(KST)

    def test_file_holds_only_room_ids_and_times_0600(self):
        s = lark_live.ActivityStore(self.path)
        s.note("oc_1", ms(2026, 9, 27, 9))
        self.assertTrue(s.flush())
        self.assertFalse(s.flush())  # 바뀐 게 없으면 쓰지 않는다
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(raw, {"schema": 1, "rooms": {"oc_1": "2026-09-27T09:00:00+09:00"}})
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        again = lark_live.ActivityStore(self.path)  # 재시작해도 이어진다
        self.assertFalse(again.note("oc_1", ms(2026, 9, 27, 8)))


class PendingTest(unittest.TestCase):
    def test_settle_and_max_wait(self):
        t = [0.0]
        p = lark_live.Pending(settle=3, max_wait=20, clock=lambda: t[0])
        self.assertIsNone(p.take())
        p.mark("발화")
        t[0] = 2
        self.assertIsNone(p.take())  # 아직 몰려오는 중
        p.mark("im_chat_updated_v1", roster=True)
        t[0] = 5.5
        self.assertEqual(p.take(), ({"발화", "im_chat_updated_v1"}, True, set(), set()))
        self.assertIsNone(p.take())
        # 쉬지 않고 이벤트가 와도 max_wait 에 한 번은 처리한다
        for i in range(0, 22, 2):
            t[0] = 100 + i
            p.mark("발화")
        self.assertEqual(p.take(), ({"발화"}, False, set(), set()))


class MemberSignatureTest(unittest.TestCase):
    def test_only_what_the_seeder_moves(self):
        office = {
            "org": {"name": "o", "environment": "trading"},
            "members": [{"key": "a", "display_name": "A", "look": None, "kind": "member", "role": "x"}],
            "excluded_keys": [],
            "boards": {"ledger": [1], "pipeline": []},
        }
        base = lark_live.member_signature(office)
        self.assertEqual(base, lark_live.member_signature({**office, "boards": {"ledger": [], "pipeline": [2]}}))
        renamed = {**office, "members": [{**office["members"][0], "display_name": "에이"}]}
        self.assertNotEqual(base, lark_live.member_signature(renamed))
        self.assertNotEqual(base, lark_live.member_signature({**office, "excluded_keys": ["a"]}))


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "out").mkdir()
        self.calls = []
        self.seed_rc = 0
        self.office = {"org": {}, "members": [{"key": "a", "display_name": "A"}], "excluded_keys": []}

        def fake_run(argv, **kw):
            cmd = argv[-1]
            self.calls.append(cmd)
            if cmd == "build":
                (self.root / "out" / "office.json").write_text(json.dumps(self.office), encoding="utf-8")
            rc = self.seed_rc if cmd == "seed" else 0
            return subprocess.CompletedProcess(argv, rc, stdout="✓ ok\n", stderr="")

        self.runner = lark_live.Runner(self.root, run=fake_run)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_seed_only_when_members_change_and_retry_after_failure(self):
        self.assertTrue(self.runner.cycle(roster=True))
        self.assertEqual(self.calls, ["roster", "build", "seed"])  # 시작 직후는 반드시 배치
        self.calls.clear()
        self.assertTrue(self.runner.cycle(roster=False))
        self.assertEqual(self.calls, ["build"])  # 직원이 그대로면 보드는 게이트웨이가 바로 서빙
        self.office["members"][0]["display_name"] = "에이"
        self.seed_rc = 1  # DeskRPG 가 아직 안 떴다
        self.calls.clear()
        self.assertFalse(self.runner.cycle(roster=False))
        self.seed_rc = 0
        self.calls.clear()
        self.assertTrue(self.runner.cycle(roster=False))
        self.assertEqual(self.calls, ["build", "seed"])  # 실패한 배치는 다음에 다시 한다


class RedactUrlQueryTest(unittest.TestCase):
    def test_connection_url_keeps_host_hides_keys(self):
        import logging

        record = logging.LogRecord(
            "Lark", logging.INFO, __file__, 1,
            "connected to wss://msg-frontier-sg.larksuite.com/ws/v2?fpid=1&access_key=SECRETKEY&ticket=T-123 [conn_id=9]",
            (), None,
        )
        self.assertTrue(lark_live.RedactUrlQuery().filter(record))
        out = record.getMessage()
        self.assertIn("wss://msg-frontier-sg.larksuite.com/ws/v2?<가림>", out)
        self.assertIn("[conn_id=9]", out)
        self.assertNotIn("SECRETKEY", out)
        self.assertNotIn("T-123", out)


class ActivityMergeTest(unittest.TestCase):
    NOW = build_office.parse_time("2026-09-27T08:00:00+09:00")

    def pipeline(self, activity):
        office, _ = build_office.build_office(FIXTURE / "data", {}, self.NOW, None, activity)
        return {p["title"]: p for p in office["boards"]["pipeline"]}, office

    def test_live_message_clears_a_zombie(self):
        pipe, office = self.pipeline({})
        self.assertTrue(pipe["가상 캠페인 B"]["zombie"])
        live = build_office.load_activity(None)
        self.assertEqual(live, {})
        pipe, office = self.pipeline({"oc_3": build_office.parse_time("2026-09-27T07:30:00+09:00")})
        self.assertEqual(pipe["가상 캠페인 B"]["quiet_days"], 0)
        self.assertFalse(pipe["가상 캠페인 B"]["zombie"])
        self.assertEqual(office["hygiene"], [])

    def test_older_live_time_never_rewinds_rooms_json(self):
        pipe, _ = self.pipeline({"oc_2": build_office.parse_time("2026-09-01T10:00:00+09:00")})
        self.assertEqual(pipe["가상 캠페인 A"]["quiet_days"], 5)  # rooms.json 의 9/22 가 더 늦다

    def test_activity_file_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            store = lark_live.ActivityStore(Path(d) / "a.json")
            store.note("oc_3", ms(2026, 9, 27, 7))
            store.flush()
            self.assertEqual(set(build_office.load_activity(Path(d) / "a.json")), {"oc_3"})


if __name__ == "__main__":
    unittest.main()


class EgressTest(unittest.TestCase):
    def test_only_lark_and_this_mac(self):
        import egress

        for host in ("localhost", "127.0.0.1", "::1", "open.larksuite.com", "msg-frontier-sg.larksuite.com", None):
            self.assertTrue(egress.is_allowed(host), host)
        for host in ("api.github.com", "pypi.org", "8.8.8.8", "open.feishu.cn", "larksuite.com.evil.io", "evil-larksuite.com"):
            self.assertFalse(egress.is_allowed(host), host)



class QuotaAwareTest(unittest.TestCase):
    """월 호출 한도(2026-09-28 사고) — 대조는 API 를 안 부르고, 이벤트는 그 방만."""

    def test_events_carry_room_ids_and_disband_costs_nothing(self):
        t = [0.0]
        p = lark_live.Pending(settle=0, max_wait=0, clock=lambda: t[0])
        p.mark("im_chat_member_user_added_v1", chats=["oc_1"])
        p.mark("im_chat_updated_v1", chats=["oc_2"])
        p.mark("im_chat_disbanded_v1", drop=["oc_2"])
        t[0] = 1
        reasons, roster, chats, drop = p.take()
        self.assertEqual((roster, chats, drop), (False, {"oc_1"}, {"oc_2"}))  # 해산된 방은 다시 읽지 않는다

    def test_runner_passes_only_the_rooms(self):
        root = Path(tempfile.mkdtemp())
        (root / "out").mkdir()
        calls = []

        def run(argv, **kw):
            calls.append(argv[2:])
            if argv[2] == "build":
                (root / "out" / "office.json").write_text(json.dumps({"members": []}), encoding="utf-8")
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        r = lark_live.Runner(root, run=run)
        r.last_signature = lark_live.member_signature({"members": []})
        r.cycle(False, {"oc_2", "oc_1"}, {"oc_9"})
        self.assertEqual(calls[0], ["roster", "--chats", "oc_1,oc_2", "--drop", "oc_9"])
        calls.clear()
        r.cycle(False)
        self.assertEqual(calls, [["build"]])  # 대조: Lark 호출 없이 빌드만
        shutil.rmtree(root)

    def test_full_roster_only_when_a_week_old(self):
        root = Path(tempfile.mkdtemp())
        (root / "out").mkdir()
        now = dt.datetime(2026, 9, 28, 12, tzinfo=KST)
        (root / "out" / "lark_roster.json").write_text(json.dumps({"full_at": "2026-09-25T07:00:00+09:00"}))
        self.assertFalse(lark_live.roster_is_stale(root, now))
        (root / "out" / "lark_roster.json").write_text(json.dumps({"full_at": "2026-09-20T07:00:00+09:00"}))
        self.assertTrue(lark_live.roster_is_stale(root, now))
        shutil.rmtree(root)
