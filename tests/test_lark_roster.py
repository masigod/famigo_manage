"""lark_roster.py · 명단 병합 회귀 테스트. 응답 모양은 larksuite/oapi-sdk-python 모델 그대로.

실행: python3 -m unittest discover -s tests
"""

import datetime as dt
import io
import json
import subprocess
import sys
import tempfile
import unittest
import os
import urllib.error
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "office"))

import build_office  # noqa: E402
import lark_roster  # noqa: E402

NOW = dt.datetime(2026, 9, 27, 8, tzinfo=lark_roster.KST)
HOME, OTHER = "t_home", "t_other"

CHATS = [
    {"chat_id": "oc_a", "name": "일일업무", "external": False, "tenant_key": HOME, "chat_status": "normal"},
    {"chat_id": "oc_b", "name": "진행중 - 가상 캠페인 A", "external": False, "tenant_key": HOME, "chat_status": "normal"},
    {"chat_id": "oc_bot", "name": "알림 봇", "external": False, "tenant_key": HOME, "chat_status": "normal"},
    {"chat_id": "oc_ext", "name": "외부 협업방", "external": True, "tenant_key": HOME, "chat_status": "normal"},
    {"chat_id": "oc_gone", "name": "해산된 방", "external": False, "tenant_key": HOME, "chat_status": "dissolved"},
]
MEMBERS = {
    "oc_a": [
        {"member_id_type": "open_id", "member_id": "ou_1", "name": "Alpha Kim", "tenant_key": HOME},
        {"member_id_type": "open_id", "member_id": "ou_2", "name": "새 직원", "tenant_key": HOME},
        {"member_id_type": "open_id", "member_id": "ou_3", "name": "Bravo Lee", "tenant_key": HOME},
    ],
    "oc_b": [
        {"member_id_type": "open_id", "member_id": "ou_1", "name": "Alpha Kim", "tenant_key": HOME},
        {"member_id_type": "open_id", "member_id": "ou_x", "name": "게스트", "tenant_key": OTHER},
    ],
    "oc_bot": [{"member_id_type": "open_id", "member_id": "ou_9", "name": "봇방사람", "tenant_key": HOME}],
    "oc_ext": [{"member_id_type": "open_id", "member_id": "ou_8", "name": "외부 담당자", "tenant_key": OTHER}],
}


class FakeLark:
    """page_size=1 로 쪼개 페이지 넘김을 강제한다."""

    def __init__(self, members=MEMBERS, chats=CHATS):
        self.members = members
        self.chats = chats
        self.calls = []

    def __call__(self, req, timeout=None):
        url = urllib.parse.urlparse(req.full_url)
        q = dict(urllib.parse.parse_qsl(url.query))
        self.calls.append((req.get_method(), url.path))
        if url.path.endswith("/tenant_access_token/internal"):
            body = json.loads(req.data)
            assert body == {"app_id": "cli_test", "app_secret": "s3cret"}
            return self._resp({"code": 0, "tenant_access_token": "t-123", "expire": 7200})
        assert req.headers["Authorization"] == "Bearer t-123"
        assert req.get_method() == "GET"  # 읽기 전용
        if url.path == "/open-apis/im/v1/chats":
            items = CHATS
        elif url.path.startswith("/open-apis/im/v1/chats/") and not url.path.endswith("/members"):
            chat_id = url.path.rsplit("/", 1)[-1]
            chat = next((c for c in self.chats if c["chat_id"] == chat_id), None)
            return self._resp({"code": 0, "msg": "success", "data": {k: v for k, v in (chat or {}).items() if k != "chat_id"}})
        else:
            assert q["member_id_type"] == "open_id"
            items = self.members.get(url.path.split("/")[-2], [])
        i = int(q.get("page_token", "0"))
        page = items[i : i + 1]
        more = i + 1 < len(items)
        data = {"items": page, "has_more": more, **({"page_token": str(i + 1)} if more else {})}
        return self._resp({"code": 0, "msg": "success", "data": data})

    @staticmethod
    def _resp(obj):
        return io.BytesIO(json.dumps(obj).encode())  # urlopen 처럼 with 로 쓸 수 있다


class RosterTest(unittest.TestCase):
    def roster(self, fake=None):
        fake = fake or FakeLark()
        client = lark_roster.LarkClient("https://open.larksuite.com", "cli_test", "s3cret", opener=fake)
        return lark_roster.build_roster(client, NOW), fake

    def test_members_deduped_across_rooms_with_room_titles(self):
        roster, _ = self.roster()
        by = {m["name"]: m for m in roster["members"]}
        self.assertEqual(set(by), {"Alpha Kim", "새 직원", "Bravo Lee"})
        self.assertEqual(by["Alpha Kim"]["rooms"], ["가상 캠페인 A", "일일업무"])  # 접두사는 뗀다

    def test_bot_external_dissolved_and_foreign_excluded(self):
        roster, _ = self.roster()
        raw = json.dumps(roster, ensure_ascii=False)
        for name in ("봇방사람", "외부 담당자", "게스트", "알림 봇", "해산된 방"):
            self.assertNotIn(name, raw)
        # 외부 방은 이름까지만 (§0.4) — 방 목록엔 있고 구성원은 안 본다
        self.assertEqual(
            [{k: r[k] for k in ("chat_id", "name", "external")} for r in roster["rooms"]],
            [
                {"chat_id": "oc_a", "name": "일일업무", "external": False},
                {"chat_id": "oc_b", "name": "진행중 - 가상 캠페인 A", "external": False},
                {"chat_id": "oc_ext", "name": "외부 협업방", "external": True},
            ],
        )
        self.assertNotIn("members", roster["rooms"][2])  # 외부 방 구성원은 보지 않는다
        self.assertEqual(roster["chats_skipped"], {"bot": 1, "external": 1, "not_normal": 1, "foreign_member": 1})

    def test_open_id_and_secret_never_stored(self):
        roster, _ = self.roster()
        raw = json.dumps(roster)
        for s in ("ou_1", "ou_2", "s3cret", "t-123", "cli_test"):
            self.assertNotIn(s, raw)

    def test_only_reads(self):
        _, fake = self.roster()
        self.assertEqual({m for m, _ in fake.calls}, {"POST", "GET"})
        self.assertEqual([p for m, p in fake.calls if m == "POST"], ["/open-apis/auth/v3/tenant_access_token/internal"])

    def test_error_code_raises(self):
        def opener(req, timeout=None):
            return FakeLark._resp({"code": 99991672, "msg": "scope"})

        client = lark_roster.LarkClient("https://x", "a", "b", opener=opener)
        with self.assertRaises(lark_roster.LarkError):
            lark_roster.build_roster(client, NOW)


class CredentialTest(unittest.TestCase):
    def test_missing_keys_named_without_values(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.json"
            p.write_text(json.dumps({"id": "x", "secret_value": "zzz"}))
            with self.assertRaises(lark_roster.LarkError) as cm:
                lark_roster.load_credentials(p)
            self.assertNotIn("zzz", str(cm.exception))


class MergeTest(unittest.TestCase):
    def test_roster_is_the_member_truth(self):
        roster, _ = RosterTest().roster()
        data = ROOT / "tests" / "fixtures" / "briefs" / "data"
        # people.json L1 은 활동 통계뿐이다(실측) — 직무는 관리자 웹(config)에서만 온다
        config = {"members": {"Alpha Kim": {"role": "운영 매니저"}}}
        office, report = build_office.build_office(data, config, NOW, roster)
        members = {m["display_name"]: m for m in office["members"] if m["kind"] == "member"}
        # Lark 에 있는 사람 전원 — people.json 에 없는 새 직원도
        self.assertEqual(set(members), {"Alpha Kim", "새 직원", "Bravo Lee"})
        # 직무는 people.json 과 이름이 맞을 때만
        self.assertEqual(members["Alpha Kim"]["role"], "운영 매니저")
        self.assertEqual(members["Alpha Kim"]["last_active"], "2026-09-23")  # L1 통계는 쓴다
        self.assertEqual(members["Alpha Kim"]["reports"], 22)
        self.assertIsNone(members["새 직원"]["role"])
        # Lark 에 없는 people.json 인물(찰리)은 직원이 아니다
        self.assertNotIn("찰리", members)
        self.assertEqual(report["roster"]["people_json_not_in_lark"], 2)  # 찰리 + 비활성 Delta
        # 장부 담당 연결은 명단 키로 이어진다
        t001 = next(t for t in office["boards"]["ledger"] if t["id"] == "T001")
        self.assertEqual(t001["assignee"], members["Alpha Kim"]["key"])
        self.assertRegex(members["새 직원"]["key"], r"^m-[0-9a-f]{8}$")
        # 명단이 있든 없든 같은 사람은 같은 키 — 소스가 바뀌어도 NPC 가 중복되지 않는다
        plain, _ = build_office.build_office(data, config, NOW, None)
        plain_keys = {m["display_name"]: m["key"] for m in plain["members"]}
        self.assertEqual(members["Alpha Kim"]["key"], plain_keys["Alpha Kim"])

    def test_api_room_names_are_stage_truth(self):
        # rooms.json 이름이 접두사를 안 들고 있어도, API 이름으로 상태를 읽고 조용한 기간은 chat_id 로 잇는다
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            (data / "rooms.json").write_text(json.dumps([
                {"chat_id": "oc_1", "title": "캠페인 X", "last_human_at": "2026-08-01T10:00:00+09:00"},
                {"chat_id": "oc_2", "title": "캠페인 Y"},
            ], ensure_ascii=False))
            api = [
                {"chat_id": "oc_1", "name": "진행중 - 캠페인 X", "external": False},
                {"chat_id": "oc_2", "name": "Cancel - 캠페인 Y", "external": False},
                {"chat_id": "oc_3", "name": "알림 봇", "external": False},
            ]
            rooms = build_office.load_rooms(data, NOW, {}, api)
            by = {r["title"]: r for r in rooms}
            self.assertEqual(set(by), {"캠페인 X", "캠페인 Y"})
            self.assertEqual(by["캠페인 X"]["stage"], "진행중")
            self.assertEqual(by["캠페인 X"]["quiet_days"], 57)
            self.assertIsNone(by["캠페인 Y"]["quiet_days"])  # 모르면 미확인
            # API 목록이 없으면 rooms.json 만 — 이 모양에선 상태를 못 읽는다(0 이 아니라 접두사 없음)
            self.assertTrue(all(r["stage"] is None for r in build_office.load_rooms(data, NOW, {}, None)))

    def test_failed_collection_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "roster.json"
            out.write_text("OLD")
            creds = Path(d) / "c.json"
            creds.write_text(json.dumps({"app_id": "a", "app_secret": "b", "domain": "http://127.0.0.1:9"}))
            r = subprocess.run(
                [sys.executable, str(ROOT / "office" / "lark_roster.py"), "--credentials", str(creds), "--out", str(out)],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertEqual(out.read_text(), "OLD")


if __name__ == "__main__":
    unittest.main()



class TargetedRefreshTest(unittest.TestCase):
    """이벤트가 가리킨 방만 — 월 호출 한도를 지키는 명단 갱신 (2026-09-28 한도 초과 사고 뒤)."""

    def full(self):
        fake = FakeLark(members={k: list(v) for k, v in MEMBERS.items()}, chats=[dict(c) for c in CHATS])
        client = lark_roster.LarkClient("https://open.larksuite.com", "cli_test", "s3cret", opener=fake)
        return lark_roster.build_roster(client, NOW), fake, client

    def test_one_room_refresh_is_cheap_and_correct(self):
        roster, fake, client = self.full()
        fake.members["oc_b"] = [
            {"member_id_type": "open_id", "member_id": "ou_9x", "name": "새 합류자", "tenant_key": HOME},
            {"member_id_type": "open_id", "member_id": "ou_y", "name": "다른 회사", "tenant_key": OTHER},
        ]
        fake.calls.clear()
        after = lark_roster.refresh_chats(client, roster, ["oc_b"], [], NOW)
        self.assertLessEqual(len(fake.calls), 5)  # 토큰 1 + 방 정보 1 + 구성원(1명씩 쪼갠 페이지) — 전체 수집의 방 수만큼이 아니다
        by = {m["name"]: m["rooms"] for m in after["members"]}
        self.assertEqual(by["Alpha Kim"], ["일일업무"])  # oc_b 에서 빠졌다
        self.assertEqual(by["새 합류자"], ["가상 캠페인 A"])
        self.assertNotIn("다른 회사", by)  # 집 테넌트 해시로 거른다
        self.assertNotIn("t_home", json.dumps(after))  # 테넌트 원문은 남기지 않는다

    def test_disbanded_room_costs_nothing(self):
        roster, fake, client = self.full()
        fake.calls.clear()
        after = lark_roster.refresh_chats(client, roster, [], ["oc_a"], NOW)
        self.assertEqual(fake.calls, [])
        names = {m["name"] for m in after["members"]}
        self.assertNotIn("새 직원", names)  # oc_a 에만 있던 사람은 빠진다
        self.assertIn("Alpha Kim", names)


class MeterTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir)

    def test_daily_budget_and_quota_block(self):
        import lark_meter

        meter = lark_meter.CallMeter(self.dir / "calls.json", daily_budget=2, today=lambda: dt.date(2026, 9, 28))
        meter.take()
        meter.take()
        with self.assertRaises(lark_meter.BudgetExceeded):
            meter.take()
        self.assertEqual(meter.quota_exceeded(), "2026-10-01")
        self.assertEqual(meter.blocked_until(), "2026-10-01")
        self.assertEqual(os.stat(self.dir / "calls.json").st_mode & 0o777, 0o600)
        nextmonth = lark_meter.CallMeter(self.dir / "calls.json", daily_budget=2, today=lambda: dt.date(2026, 10, 1))
        nextmonth.take()  # 다음 달이면 다시 된다

    def test_quota_exceeded_stops_without_retry(self):
        import lark_meter

        calls = []

        def opener(req, timeout=None):
            calls.append(req.full_url)
            body = io.BytesIO(json.dumps({"code": 99991403, "msg": "This month's API call quota has been exceeded"}).encode())
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, body)

        meter = lark_meter.CallMeter(self.dir / "calls.json", today=lambda: dt.date(2026, 9, 28))
        client = lark_roster.LarkClient("https://open.larksuite.com", "a", "b", opener=opener, meter=meter)
        with self.assertRaises(lark_roster.LarkError) as cm:
            client.authenticate()
        self.assertIn("2026-10-01", str(cm.exception))
        self.assertEqual(len(calls), 1)  # 재시도로 한도를 더 쓰지 않는다
        with self.assertRaises(lark_roster.LarkError):
            client.authenticate()
        self.assertEqual(len(calls), 1)  # 막힌 뒤로는 나가지도 않는다
