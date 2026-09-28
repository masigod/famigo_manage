"""build_insights.py · 실시간 원문 저장 회귀 테스트 — 합성 원문만.

실행: python3 -m unittest discover -s tests
"""

import datetime as dt
import json
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "office"))

import build_insights  # noqa: E402
import lark_live  # noqa: E402

NOW = build_insights.parse_time("2026-09-27T08:00:00+09:00")

REPORT_A = """[일일업무보고] 2026.09.21 기준
📌 금일 핵심 요약
가상 패널 정비
-
가상 조사 기능 점검
📌 우선 액션아이템
High
-
가상 기준 구체화
Low
-
가상 회신 대기
✅ 현재 진행상태
-
가상 캠페인: 정리 중"""

REPORT_B = """[일일보고] 9/22
오늘 업무
1.
가상 인터뷰 준비
내일 업무
- 가상 리워드 발송
현재 막혀있는 부분
- 가상 고객사 회신 없음
이슈/리스크: 없음
지원 필요: 가상 디자인 검토
협조 필요: 없음(진행 중"""


def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


class ParseDailyReportTest(unittest.TestCase):
    def test_structured_template(self):
        r = build_insights.parse_daily_report(REPORT_A)
        self.assertEqual(r["today"], ["가상 패널 정비", "가상 조사 기능 점검"])
        self.assertEqual(r["actions"]["high"], ["가상 기준 구체화"])
        self.assertEqual(r["actions"]["low"], ["가상 회신 대기"])
        self.assertEqual(r["doing"], ["가상 캠페인: 정리 중"])

    def test_plain_template_and_none_is_not_an_item(self):
        r = build_insights.parse_daily_report(REPORT_B)
        self.assertEqual(r["today"], ["가상 인터뷰 준비"])
        self.assertEqual(r["next"], ["가상 리워드 발송"])
        self.assertEqual(r["blocked"], ["가상 고객사 회신 없음"])  # '이슈/리스크: 없음'은 항목이 아니다
        self.assertEqual(r["support"], ["가상 디자인 검토"])  # '협조 필요: 없음(진행 중'도 아니다

    def test_not_a_report(self):
        self.assertIsNone(build_insights.parse_daily_report("점심 뭐 먹지"))


class BuildInsightsTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.briefs = self.dir / "briefs"
        data = self.briefs / "data"
        shutil.copytree(ROOT / "tests" / "fixtures" / "briefs" / "data", data)
        raw = data / "raw" / "2026-W39_0921-0927"
        write_jsonl(raw / "2026-09-21__일일업무.jsonl", [
            {"ts": "2026-09-21T19:00:00", "date": "2026-09-21", "author": "Alpha Kim", "text": REPORT_A, "msg_id": "m1", "msg_type": "post"},
            {"ts": "2026-09-21T19:05:00", "date": "2026-09-21", "author": "Bravo Lee", "text": REPORT_B, "msg_id": "m2", "msg_type": "post"},
            {"ts": "2026-09-21T19:06:00", "date": "2026-09-21", "author": "system", "text": "[system]", "msg_id": "m3", "msg_type": "system"},
        ])
        write_jsonl(raw / "2026-09-22__일일업무.jsonl", [
            {"ts": "2026-09-22T10:00:00", "date": "2026-09-22", "author": "Alpha Kim", "text": "같은 msg_id 는 한 번만", "msg_id": "m1"},
        ])
        (data / "raw" / "2026-08-29").mkdir(parents=True)
        (data / "raw" / "2026-08-29" / "2026-08-29__dm_01.jsonl").write_text("")
        self.live = self.dir / "out" / "live" / "messages.jsonl"
        write_jsonl(self.live, [
            {"ts": "2026-09-27T09:00:00", "date": "2026-09-27", "author": "Alpha Kim", "text": "실시간 가상 메시지", "msg_id": "L1", "room": "일일업무"},
            {"ts": "2026-09-21T19:00:00", "date": "2026-09-21", "author": "Alpha Kim", "text": "예약 원문과 겹침", "msg_id": "m1", "room": "일일업무"},
        ])
        reports = self.briefs / "reports"
        (reports / "2026-W39_0921-0927").mkdir(parents=True)
        (reports / "2026-W39_0921-0927" / "2026-09-21_daily.md").write_text("# 가상 일간\n")
        (reports / "_analysis").mkdir()
        (reports / "_analysis" / "종합.md").write_text("# 가상 종합 분석\n")
        (self.briefs / "lark_daily_brief_20260927.md").write_text(
            "# 가상 브리핑\n\n## 오늘 결정할 것\n\n### 1. 가상 결정 A\n\n### 2. 가상 결정 B\n\n## 진행 상태\n"
        )
        roster = {"members": [{"id": "h1", "name": "Alpha Kim"}, {"id": "h2", "name": "Bravo Lee"}]}
        self.insights = build_insights.build_insights(data, self.briefs, roster, self.live, NOW)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_messages_merge_live_without_duplicates(self):
        ids = [m["id"] for m in self.insights["messages"]]
        self.assertEqual(sorted(ids), ["L1", "m1", "m2", "m3"])
        self.assertEqual(next(m for m in self.insights["messages"] if m["id"] == "m1")["live"], False)  # 예약 원문이 정본
        self.assertEqual(self.insights["coverage"]["live_messages"], 1)

    def test_person_gets_own_reports_todos_and_layers(self):
        a = self.insights["persons"]["Alpha Kim"]
        self.assertEqual(a["stats"]["messages"], 2)  # 일일보고 + 실시간 1건, system 은 세지 않는다
        self.assertEqual(len(a["daily_reports"]), 1)
        self.assertEqual(a["daily_reports"][0]["actions"]["high"], ["가상 기준 구체화"])
        self.assertIn("T001", a["todos"])  # 장부 담당(who)이 Lark 이름과 같을 때만 붙는다
        self.assertIn("패턴", a["local_layers"])  # L1 밖의 층은 관리자용으로 보존
        self.assertNotIn("system", self.insights["persons"])

    def test_reports_and_decisions_indexed(self):
        kinds = {r["kind"] for r in self.insights["reports"]}
        self.assertEqual(kinds, {"brief", "daily", "analysis"})
        self.assertEqual(self.insights["decisions"]["items"], ["1. 가상 결정 A", "2. 가상 결정 B"])


class LiveRecordTest(unittest.TestCase):
    """실시간 원문: 예약 루틴과 같은 거름망 · 모르는 방/봇 방/1:1 은 저장하지 않는다."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        open_id = "ou_abcdef1234567890"
        import hashlib

        roster = {
            "members": [{"id": hashlib.sha256(open_id.encode()).hexdigest()[:16], "name": "Alpha Kim"}],
            "rooms": [{"chat_id": "oc_1", "name": "일일업무"}, {"chat_id": "oc_bot", "name": "알림 BOT"},
                      {"chat_id": "oc_ext", "name": "외부 방", "external": True}],
        }
        (self.dir / "roster.json").write_text(json.dumps(roster), encoding="utf-8")
        self.directory = lark_live.Directory(self.dir / "roster.json")
        self.open_id = open_id
        # 예약 루틴 거름망과 같은 모양(이름·시그니처)의 합성 거름망
        self.filters = (
            lambda m: json.loads(m["body"]["content"]).get("text", ""),
            re.compile(r"인증\s*코드|password", re.I),
            lambda t: (re.sub(r"01\d-\d{4}-\d{4}", "[전화번호]", t), len(re.findall(r"01\d-\d{4}-\d{4}", t))),
            lambda name: "bot" in name.lower(),
        )

    def tearDown(self):
        shutil.rmtree(self.dir)

    def event(self, text, chat="oc_1", chat_type="group", sender_type="user", open_id=None):
        msg = types.SimpleNamespace(
            chat_id=chat, chat_type=chat_type, create_time=str(int(dt.datetime(2026, 9, 28, 10, tzinfo=lark_live.KST).timestamp() * 1000)),
            message_type="text", content=json.dumps({"text": text}), message_id="om_1", thread_id=None,
        )
        sender = types.SimpleNamespace(sender_type=sender_type, sender_id=types.SimpleNamespace(open_id=open_id or self.open_id))
        return types.SimpleNamespace(event=types.SimpleNamespace(message=msg, sender=sender))

    def test_same_shape_as_brief_raw_with_filters(self):
        row = lark_live.live_record(self.event("연락처 010-1234-5678"), self.directory, self.filters)
        self.assertEqual(row["author"], "Alpha Kim")
        self.assertEqual(row["room"], "일일업무")
        self.assertEqual((row["date"], row["ts"]), ("2026-09-28", "2026-09-28T10:00:00"))
        self.assertEqual(row["text"], "연락처 [전화번호]")
        self.assertNotIn("ou_", json.dumps(row))  # open_id 원문은 남지 않는다
        secret = lark_live.live_record(self.event("인증 코드 123456"), self.directory, self.filters)
        self.assertTrue(secret["redacted"])
        self.assertNotIn("123456", secret["text"])

    def test_not_stored(self):
        for ev in (
            self.event("x", chat="oc_bot"),
            self.event("x", chat="oc_ext"),
            self.event("x", chat="oc_unknown"),
            self.event("x", chat_type="p2p"),
            self.event("x", sender_type="app"),
        ):
            self.assertIsNone(lark_live.live_record(ev, self.directory, self.filters))
        self.assertIsNone(lark_live.live_record(self.event("x"), self.directory, None))  # 거름망 없으면 fail-closed

    def test_unknown_sender_uses_brief_notation(self):
        row = lark_live.live_record(self.event("x", open_id="ou_zzzzzz999888"), self.directory, self.filters)
        self.assertEqual(row["author"], "user:999888")

    def test_store_dedupes_and_compacts(self):
        store = lark_live.LiveMessages(self.dir / "live" / "messages.jsonl")
        row = lark_live.live_record(self.event("x"), self.directory, self.filters)
        self.assertTrue(store.add(row))
        self.assertFalse(store.add(row))
        self.assertEqual(os.stat(store.path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(store.path.parent).st_mode & 0o777, 0o700)
        self.assertEqual(store.compact(dt.date(2026, 10, 30)), 1)
        self.assertEqual(store.path.read_text(), "")


if __name__ == "__main__":
    unittest.main()


class WorkCardsTest(unittest.TestCase):
    """일일보고·실시간 발화 → 사무실 기본 보드의 업무 카드 (3D 사무실에 녹아드는 일)."""

    NOW = build_insights.parse_time("2026-09-22T09:00:00+09:00")

    def cards(self, messages, keys=None):
        import build_office

        keys = keys if keys is not None else {"alpha kim": "alpha-kim", "bravo lee": "bravo-lee"}
        return build_office.work_cards(messages, lambda n: keys.get((n or "").lower()), self.NOW)

    def test_sections_become_statuses_and_fresh_doing_is_running(self):
        cards = self.cards([{"author": "Bravo Lee", "ts": "2026-09-21T19:05:00", "date": "2026-09-21", "room": "일일업무", "text": REPORT_B}])
        by = {c["title"]: c for c in cards}
        self.assertEqual(by["가상 인터뷰 준비"]["status"], "done")
        self.assertEqual(by["가상 리워드 발송"]["status"], "todo")
        self.assertEqual(by["가상 고객사 회신 없음"]["status"], "blocked")
        self.assertEqual(by["가상 디자인 검토"]["status"], "review")
        self.assertTrue(all(c["assignee"] == "bravo-lee" for c in cards))
        a = self.cards([{"author": "Alpha Kim", "ts": "2026-09-21T19:00:00", "date": "2026-09-21", "room": "일일업무", "text": REPORT_A}])
        self.assertEqual({c["title"]: c["status"] for c in a}["가상 캠페인: 정리 중"], "running")  # 14시간 전 보고의 '진행 중'

    def test_old_report_is_not_running_and_very_old_is_gone(self):
        old = [{"author": "Alpha Kim", "ts": "2026-09-19T19:00:00", "date": "2026-09-19", "room": "일일업무", "text": REPORT_A}]
        self.assertEqual({c["title"]: c["status"] for c in self.cards(old)}["가상 캠페인: 정리 중"], "todo")
        ancient = [{"author": "Alpha Kim", "ts": "2026-09-01T19:00:00", "date": "2026-09-01", "room": "일일업무", "text": REPORT_A}]
        self.assertEqual([c for c in self.cards(ancient) if c["section"] != "presence"], [])

    def test_presence_is_room_only_and_expires(self):
        recent = [{"author": "Alpha Kim", "ts": "2026-09-22T08:45:00", "date": "2026-09-22", "room": "파미고 실무팀", "text": "PRIVATE-BODY"}]
        p = [c for c in self.cards(recent) if c["section"] == "presence"]
        self.assertEqual((p[0]["title"], p[0]["status"], p[0]["id"]), ("지금 Lark · 파미고 실무팀", "running", "P-alpha-kim"))
        self.assertNotIn("PRIVATE-BODY", json.dumps(p, ensure_ascii=False))
        stale = [{"author": "Alpha Kim", "ts": "2026-09-22T08:00:00", "date": "2026-09-22", "room": "x", "text": "y"}]
        self.assertEqual([c for c in self.cards(stale) if c["section"] == "presence"], [])

    def test_people_not_in_office_get_no_cards(self):
        msgs = [{"author": "Alpha Kim", "ts": "2026-09-22T08:50:00", "date": "2026-09-22", "room": "일일업무", "text": REPORT_A}]
        self.assertEqual(self.cards(msgs, keys={}), [])  # 관리자가 퇴장시킨 사람·명단 밖
