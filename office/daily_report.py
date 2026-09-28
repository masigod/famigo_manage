"""일일보고 — 그 사람이 스스로 쓴 '오늘의 일'을 읽는다. 대시보드(build_insights)와 사무실(build_office)이 함께 쓴다.

일일보고는 Lark 의 공용 방(`일일업무` 등)에 팀이 함께 보라고 올린 글이다. 그래서 그 항목은 사무실 보드에
올라가 팀이 본다(2026-09-28 Dylan 결정: 실제 업무가 3D 사무실에 녹아들게). 그 밖의 원문은 보드에 오르지 않는다.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path

# 일일보고 머리 — 스킬 §3.1: `[일일보고]`·`[일일업무보고]`·`(Work today)`
REPORT_HEAD_RE = re.compile(r"\[\s*일일(?:업무)?보고\s*\]|\(\s*work\s*today\s*\)", re.I)
# 절 이름 — 실측(2026-09-28, 일일보고 321건의 머리줄 빈도)에서 뽑았다. 위에서부터 첫 일치.
# '다음'을 '진행 중'보다 먼저 본다: "다음주 진행 예정 업무"·"내일 진행 업무"에 '진행'이 들어 있다.
SECTION_RULES = [
    ("next", re.compile(r"내일|다음\s*주|다음\s*진행|예정\s*업무|future\s*work|next", re.I)),
    ("support", re.compile(r"지원\s*필요|협조|도움|요청\s*사항|support|help", re.I)),
    ("blocked", re.compile(r"막혀|막힘|이슈|리스크|블로커|문제|issue|block|risk", re.I)),
    ("actions", re.compile(r"액션|action\s*item|우선\s*순위", re.I)),
    ("doing", re.compile(r"진행\s*중|진행\s*상태|진행\s*현황|세부\s*진행|현재\s*진행|in\s*progress|status", re.I)),
    ("today", re.compile(r"오늘|금일|핵심\s*요약|진행\s*내용|결과|work\s*today|today|done", re.I)),
]
SECTIONS = ("today", "doing", "next", "blocked", "support")
PRIORITY_RE = re.compile(r"^(high|mid|medium|low|긴급|높음|중간|낮음)\s*:?$", re.I)
BULLET_RE = re.compile(r"^\s*(?:[-•·▪*]|\d{1,2}[.)]|[a-z][.)])\s*", re.I)
DECOR_RE = re.compile(r"^[\s📌✅⚠️🔥❗️🚩■□#【】<>()\[\]*]+|[\s【】<>()\[\]*]+$")
NONE_RE = re.compile(r"^(없음|없습니다|없어요|해당\s*없음|n/?a|none|-|x)\.?(\s*[(（\[].*)?$", re.I)  # "없음(진행 중" 도 없음
LABEL_RE = re.compile(r"^(?P<label>[^:：]{1,25})[:：]\s*(?P<value>.*)$")


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    if not path or not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _section_of(label: str) -> str | None:
    return next((k for k, pat in SECTION_RULES if pat.search(label)), None)


def parse_daily_report(text: str) -> dict | None:
    """일일보고 본문 → 절별 항목. 머리가 없으면 None.

    {today, doing, next, blocked, support: [..], actions: {high, mid, low, other}}
    - 절 머리는 짧은 줄(장식 제외 30자 이하)이면서 절 이름에 맞는 줄이다. `라벨: 값` 한 줄 형식이면 값도 항목이다.
    - '없음'은 항목이 아니다 — '이슈/리스크: 없음'을 이슈 1건으로 세면 거짓이 된다.
    - Lark post 는 '-' 한 줄 + 본문 한 줄로 쪼개져 오므로 빈 글머리·번호만 있는 줄은 버린다.
    """
    if not REPORT_HEAD_RE.search(text or ""):
        return None
    out = {k: [] for k in SECTIONS} | {"actions": {"high": [], "mid": [], "low": [], "other": []}}
    section, priority = "today", "other"

    def add(item: str):
        item = item.strip()
        if not item or NONE_RE.match(item) or BULLET_RE.fullmatch(item + " "):
            return
        if section == "actions":
            out["actions"][priority].append(item)
        else:
            out[section].append(item)

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if REPORT_HEAD_RE.search(line) and len(line) < 60:
            continue  # 머리줄([일일업무보고] 2026.09.21 기준)
        bare = DECOR_RE.sub("", BULLET_RE.sub("", line)).strip()
        if not bare:
            continue
        if section == "actions" and PRIORITY_RE.match(bare):
            p = bare.lower().rstrip(":")
            priority = {"high": "high", "긴급": "high", "높음": "high", "mid": "mid", "medium": "mid", "중간": "mid"}.get(p, "low")
            continue
        labelled = LABEL_RE.match(bare)
        if labelled and _section_of(labelled.group("label")):
            section, priority = _section_of(labelled.group("label")), "other"
            add(labelled.group("value"))
            continue
        if len(bare) <= 30 and not BULLET_RE.match(raw) and _section_of(bare):
            section, priority = _section_of(bare), "other"
            continue
        add(bare)
    return out



def recent_messages(data_dir: Path, live_path: Path | None, since: dt.date) -> list[dict]:
    """since 이후 원문(예약 원문 주 폴더 + 실시간). msg_id 로 합치고 시간순. system 발화는 뺀다."""
    out, seen = [], set()
    files = []
    for week in sorted((data_dir / "raw").glob("*")):
        files += [f for f in week.glob("*.jsonl") if f.name[:10] >= since.isoformat() and "__dm_" not in f.name]
    rows = [r for f in sorted(files) for r in read_jsonl(f)]  # 예약 원문이 정본 — 먼저 읽어 msg_id 를 차지한다
    rows += read_jsonl(live_path)
    for r in rows:
        mid = r.get("msg_id")
        if mid and mid in seen:
            continue
        if mid:
            seen.add(mid)
        if r.get("msg_type") == "system" or (r.get("author") or "?") in {"?", "system"}:
            continue
        if (r.get("date") or "") < since.isoformat():
            continue
        out.append(r)
    out.sort(key=lambda r: r.get("ts") or "")
    return out


def latest_reports(messages: list[dict]) -> dict[str, dict]:
    """사람별 가장 최근 일일보고 {author: {date, ts, room, sections…}}."""
    latest = {}
    for m in messages:
        report = parse_daily_report(m.get("text") or "")
        if report:
            latest[m["author"]] = {"date": m.get("date"), "ts": m.get("ts"), "room": m.get("room"), **report}
    return latest


def latest_activity(messages: list[dict]) -> dict[str, dict]:
    """사람별 마지막 발화 {author: {ts, room}} — 본문은 담지 않는다."""
    last = {}
    for m in messages:
        last[m["author"]] = {"ts": m.get("ts"), "room": m.get("room")}
    return last
