#!/usr/bin/env python3
"""말투·성향 → 사무실 캐릭터(외형) 매칭 (out/persona.json, 0600, 로컬 전용).

왜: 직원의 외형이 이름 해시로 무작위였다. 2026-09-28 Dylan: "대화를 분석해 성별·말투로 캐릭터를 매칭해 적용".

무엇을 재는가 (자기가 쓴 글만, system·첨부 자리표시 제외):
  말투    격식체(-습니다) · 해요체(-요) · 반말 비율
  분위기  이모지·웃음(ㅋㅋ·^^·!!) 빈도, 평균 글 길이
  역할    요청·결정 표현, 크리에이티브 어휘
값을 **팀 안의 순위**로 바꿔 외형 분류(leadership·creative·casual·classic)와 자세(composed·bright·relaxed)를 정한다.

성별(몸형)은 **대화에 근거가 있을 때만** 쓴다. 2026-09-28 실측: 17명 원문 1만여 건에서 이름 뒤 호칭(언니·형 등)·
자기 지칭·L2·L3 분석문 속 성별 표현이 모두 0건이었다 — 대화로는 정할 수 없다. 그래서 몸형은
관리자 지정(관리자 웹) > 지금 외형의 몸형 순서로 정하고, 둘 다 없으면 '미정'으로 표시한다. 영어 닉네임으로 짐작하지 않는다.

  python3 office/persona.py --insights out/insights.json --looks out/looks.json \
      --config config/office.config.json --seed-state out/seed_state.json --office out/office.json --out out/persona.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

MIN_MESSAGES = 15  # 이보다 적으면 말투를 판정하지 않는다(지금 외형 유지)

FORMAL_RE = re.compile(r"(습니다|습니까|십시오|십니다|니다|드립니다|됩니다|입니다)[.!?~…\s)]*$")
POLITE_RE = re.compile(r"요[.!?~…^\s)]*$")
PLAIN_RE = re.compile(r"(다|어|야|지|네|군|거든|잖아)[.!?~…\s)]*$")
# 개조식(보고체) — 업무 글 대부분이 명사로 끝난다: '~완료', '~예정', '~진행 중'. 실측(2026-09-28): 이것을 안 세면
# 문장의 80% 이상이 어느 말투에도 잡히지 않았다.
TERSE_RE = re.compile(r"(완료|예정|진행|중|필요|확인|정리|공유|요청|대기|검토|협의|전달|반영|수정|준비|완|함|됨|임|음|건|명|원)[.)\]\s]*$")
EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]|ㅋ{2,}|ㅎ{2,}|\^\^|!{2,}|~{2,}")
DIRECTIVE_RE = re.compile(r"부탁|해\s*주세요|해주시|확인\s*바랍|검토\s*(부탁|바랍|해)|진행\s*해\s*주|결정|공유\s*부탁|요청\s*드|지시|컨펌|확정해")
CREATIVE_RE = re.compile(r"디자인|콘텐츠|컨텐츠|영상|촬영|편집|인스타|릴스|카피|썸네일|이미지|브랜딩|크리에이티브|숏폼|유튜브")
PLACEHOLDER_RE = re.compile(r"^\[(image|file|media|audio|sticker|video|카드|system|share_chat|share_user|folder)[^\]]*\]$")


def read_json(path: Path | None, default):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else default
    except (OSError, ValueError):
        return default


def style_of(texts: list[str]) -> dict | None:
    texts = [t.strip() for t in texts if t and t.strip() and not PLACEHOLDER_RE.match(t.strip())]
    if len(texts) < MIN_MESSAGES:
        return None
    formal = polite = plain = terse = sentences = 0
    for t in texts:
        for line in (l.strip() for l in t.splitlines()):
            if len(line) < 4:
                continue
            sentences += 1
            if FORMAL_RE.search(line):
                formal += 1
            elif POLITE_RE.search(line):
                polite += 1
            elif PLAIN_RE.search(line):
                plain += 1
            elif TERSE_RE.search(line):
                terse += 1
    n = len(texts)
    return {
        "messages": n,
        "formal": formal / sentences if sentences else 0.0,
        "polite": polite / sentences if sentences else 0.0,
        "plain": plain / sentences if sentences else 0.0,
        "terse": terse / sentences if sentences else 0.0,
        "emoji": sum(len(EMOJI_RE.findall(t)) for t in texts) / n,
        "avg_len": sum(len(t) for t in texts) / n,
        "directive": sum(1 for t in texts if DIRECTIVE_RE.search(t)) / n,
        "creative": sum(1 for t in texts if CREATIVE_RE.search(t)) / n,
    }


def ranks(values: dict[str, float]) -> dict[str, float]:
    """팀 안 백분위(0~1). 한 명이면 0.5."""
    if len(values) < 2:
        return {k: 0.5 for k in values}
    order = sorted(values, key=lambda k: values[k])
    return {k: i / (len(order) - 1) for i, k in enumerate(order)}


def classify(styles: dict[str, dict]) -> dict[str, dict]:
    """사람별 {category, stance, scores} — 절대값이 아니라 팀 안의 상대 위치로 정한다."""
    r = {f: ranks({k: s[f] for k, s in styles.items()}) for f in ("formal", "polite", "plain", "terse", "emoji", "avg_len", "directive", "creative")}
    out = {}
    for k in styles:
        scores = {
            "leadership": 0.7 * r["directive"][k] + 0.3 * r["formal"][k],
            # 크리에이티브는 어휘가 근거다 — 이모지만 많다고 크리에이티브가 되지 않게(실측: 어휘 0% 인데 판정됐다).
            "creative": 0.8 * r["creative"][k] + 0.2 * r["emoji"][k] if styles[k]["creative"] > 0 else 0.0,
            "casual": 0.4 * r["emoji"][k] + 0.3 * max(r["polite"][k], r["plain"][k]) + 0.3 * (1 - r["avg_len"][k]),
            "classic": 0.35 * r["formal"][k] + 0.35 * r["terse"][k] + 0.3 * r["avg_len"][k],
        }
        category = max(scores, key=lambda c: (scores[c], c == "classic"))  # 동점이면 클래식
        stance = "composed" if r["formal"][k] >= 0.6 and r["emoji"][k] < 0.6 else "bright" if r["emoji"][k] >= 0.6 else "relaxed"
        out[k] = {"category": category, "stance": stance, "scores": {c: round(v, 3) for c, v in scores.items()}}
    return out


def evidence(s: dict) -> str:
    return (
        f"격식체 {s['formal']:.0%} · 해요체 {s['polite']:.0%} · 반말 {s['plain']:.0%} · 개조식 {s['terse']:.0%} · "
        f"이모지·웃음 {s['emoji']:.2f}/건 · 평균 {s['avg_len']:.0f}자 · 요청·결정 {s['directive']:.0%} · "
        f"크리에이티브 어휘 {s['creative']:.0%} (글 {s['messages']}건)"
    )


def pick_looks(people: list[dict], looks: list[dict]) -> dict[str, str]:
    """사람별 외형 — 분류·몸형이 맞는 것 중 자세가 맞는 것을 먼저, 겹치지 않게. 많이 말한 사람부터."""
    taken: set[str] = set()
    chosen = {}
    for p in sorted(people, key=lambda p: (-p["messages"], p["name"])):
        pool = [l for l in looks if l["id"] not in taken and l.get("bodyType") == p["bodyType"]]
        ranked = sorted(
            pool,
            key=lambda l: (
                l.get("category") != p["category"],
                l.get("stance") != p["stance"],
                hashlib.sha1(f"{p['name']}|{l['id']}".encode()).hexdigest(),  # 결정적 순서
            ),
        )
        if ranked:
            chosen[p["name"]] = ranked[0]["id"]
            taken.add(ranked[0]["id"])
    return chosen


def build_persona(insights: dict, looks: list[dict], config: dict, seed_state: dict, office: dict) -> dict:
    by_id = {l["id"]: l for l in looks}
    members = config.get("members", {})
    key_of = {a: m["key"] for m in office.get("members", []) for a in m.get("aliases", [])}
    current = seed_state.get("looks", {})  # 시더가 기록한 지금 외형 {직원 키: 외형 id}
    texts: dict[str, list[str]] = {}
    for m in insights.get("messages", []):
        if m.get("type") != "system" and not str(m.get("author", "?")).startswith(("user:", "?")):
            texts.setdefault(m["author"], []).append(m.get("text") or "")
    styles = {n: s for n, t in texts.items() if (s := style_of(t))}
    classes = classify(styles)

    people, result = [], {}
    for name, s in styles.items():
        body = members.get(name, {}).get("body")
        now_look = by_id.get(current.get(key_of.get(name, "")))
        if body in ("female", "male"):
            body_type, body_source = body, "관리자 지정"
        elif now_look:
            body_type, body_source = now_look["bodyType"], "지금 외형 유지 (대화에 성별 근거 없음)"
        else:
            body_type, body_source = None, "미정 — 관리자 웹에서 몸형을 정하세요"
        c = classes[name]
        result[name] = {
            "category": c["category"], "stance": c["stance"], "scores": c["scores"],
            "body_type": body_type, "body_source": body_source, "evidence": evidence(s), "look": None,
        }
        if body_type:
            people.append({"name": name, "messages": s["messages"], "bodyType": body_type, **c})
    for name, look_id in pick_looks(people, looks).items():
        result[name]["look"] = look_id
    return {"schema": 1, "people": dict(sorted(result.items())), "judged": len(styles), "min_messages": MIN_MESSAGES}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--insights", type=Path, required=True)
    ap.add_argument("--looks", type=Path, required=True)
    ap.add_argument("--config", type=Path)
    ap.add_argument("--seed-state", type=Path)
    ap.add_argument("--office", type=Path)
    ap.add_argument("--out", type=Path, default=Path("out/persona.json"))
    args = ap.parse_args(argv)
    looks = read_json(args.looks, None)
    insights = read_json(args.insights, None)
    if not looks or not insights:
        print(f"✗ 외형 목록({args.looks}) 또는 인사이트({args.insights})가 없다", file=sys.stderr)
        return 2
    persona = build_persona(insights, looks, read_json(args.config, {}), read_json(args.seed_state, {}), read_json(args.office, {}))
    tmp = args.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(persona, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(args.out)
    cats = {}
    for p in persona["people"].values():
        cats[p["category"]] = cats.get(p["category"], 0) + 1
    undecided = sum(1 for p in persona["people"].values() if not p["body_type"])
    print(f"✓ {args.out} · 판정 {persona['judged']}명 ({' · '.join(f'{k} {v}' for k, v in sorted(cats.items()))}) · 몸형 미정 {undecided}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
