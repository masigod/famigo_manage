"""persona.py (말투·성향 → 외형) 회귀 테스트 — 합성 글·합성 외형만."""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "office"))

import persona  # noqa: E402

LOOKS = json.loads((ROOT / "tests" / "fixtures" / "looks.json").read_text(encoding="utf-8"))


def msgs(author, texts):
    return [{"author": author, "type": "text", "text": t} for t in texts]


LEADER = ["가상 일정 확정해주세요. 검토 부탁드립니다."] * 20
CREATOR = ["가상 인스타 릴스 영상 편집 완료했어요 ㅋㅋ"] * 20
REPORTER = ["가상 업무 정리 완료\n가상 자료 공유 예정\n가상 회신 대기"] * 20
CHATTY = ["넵 ㅋㅋ", "좋아요!!", "ㅎㅎ 확인요"] * 7
EMOJI_ONLY = ["좋아요 ㅋㅋㅋ 😀", "넵!! ^^"] * 10


class PersonaTest(unittest.TestCase):
    def build(self, messages, config=None, seed_looks=None):
        office = {"members": [{"key": k, "aliases": [n]} for n, k in (("Lead", "lead"), ("Creator", "creator"), ("Reporter", "reporter"), ("Chatty", "chatty"), ("Quiet", "quiet"), ("Emo", "emo"))]}
        seed = {"looks": seed_looks if seed_looks is not None else {"lead": "office-jun", "creator": "office-seo", "reporter": "office-tae", "chatty": "office-eun", "emo": "office-do"}}
        return persona.build_persona({"messages": messages}, LOOKS, config or {}, seed, office)["people"]

    def test_categories_follow_team_relative_style(self):
        p = self.build(msgs("Lead", LEADER) + msgs("Creator", CREATOR) + msgs("Reporter", REPORTER) + msgs("Chatty", CHATTY))
        self.assertEqual(p["Lead"]["category"], "leadership")
        self.assertEqual(p["Creator"]["category"], "creative")
        self.assertEqual(p["Reporter"]["category"], "classic")
        self.assertEqual(p["Chatty"]["category"], "casual")
        self.assertIn("개조식", p["Reporter"]["evidence"])

    def test_too_few_messages_are_not_judged(self):
        p = self.build(msgs("Quiet", ["가상 한 줄"] * 5) + msgs("Lead", LEADER))
        self.assertNotIn("Quiet", p)

    def test_emoji_alone_is_not_creative(self):
        p = self.build(msgs("Emo", EMOJI_ONLY) + msgs("Lead", LEADER) + msgs("Reporter", REPORTER))
        self.assertNotEqual(p["Emo"]["category"], "creative")

    def test_body_type_from_admin_then_current_look_never_guessed(self):
        p = self.build(msgs("Lead", LEADER) + msgs("Creator", CREATOR), config={"members": {"Lead": {"body": "female"}}})
        self.assertEqual((p["Lead"]["body_type"], p["Lead"]["body_source"]), ("female", "관리자 지정"))
        self.assertEqual(p["Creator"]["body_type"], "female")  # 지금 외형(office-seo)의 몸형을 잇는다
        self.assertTrue(p["Creator"]["body_source"].startswith("지금 외형 유지"))
        looks = {l["id"]: l for l in LOOKS}
        for v in p.values():
            self.assertEqual(looks[v["look"]]["bodyType"], v["body_type"])
        new = self.build(msgs("Lead", LEADER), seed_looks={})
        self.assertIsNone(new["Lead"]["body_type"])  # 근거 없으면 정하지 않는다
        self.assertIsNone(new["Lead"]["look"])

    def test_looks_are_unique_and_match_category_when_possible(self):
        p = self.build(msgs("Lead", LEADER) + msgs("Creator", CREATOR) + msgs("Reporter", REPORTER) + msgs("Chatty", CHATTY))
        chosen = [v["look"] for v in p.values()]
        self.assertEqual(len(chosen), len(set(chosen)))
        looks = {l["id"]: l for l in LOOKS}
        self.assertEqual(looks[p["Lead"]["look"]]["category"], "leadership")


if __name__ == "__main__":
    unittest.main()
