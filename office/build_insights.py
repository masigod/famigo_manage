#!/usr/bin/env python3
"""Lark 원문 + 예약 산출물 → 사람별·관리자용 인사이트(out/insights.json, 0600, 로컬 전용).

왜: 사무실(office.json)은 반출 게이트를 통과한 팀 공용 모델이다. 그런데 각자는 **자기가 쓴 글과
자기 일**을, 관리자(Dylan 과 Dylan 이 지정한 사람)는 **전부**(원문·리포트·분석·L2·L3)를 봐야 한다(2026-09-28 결정).
그 층은 게이트를 통과하면 사라지므로 따로 만든다. 이 파일은 인증된 대시보드와 1:1 대화만 읽는다 —
누가 무엇을 보는지는 거기서 가른다(dashboard/server.mjs · gateway/personal.mjs).

읽는 것 (모두 읽기 전용):
  briefs/data/raw/**/*.jsonl      예약 루틴이 쌓은 원문 (정본)
  out/live/messages.jsonl         lark_live.py 가 실시간으로 받은 원문 (07:00 수집 전까지의 보충)
  briefs/data/people.json         L1 + 그 밖의 층(L2·L3) — 관리자 화면에서만 쓴다
  briefs/data/todos.jsonl · campaigns.json   담당 항목
  briefs/lark_daily_brief_*.md · briefs/reports/**   브리핑·일간·주간·월간·종합 분석
  out/lark_roster.json            지금 Lark 에 있는 사람

원문은 예약 루틴이 저장할 때 이미 2FA·자격증명 폐기와 PII 마스킹을 거쳤다(lark_store.save_raw).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_office import KST, STALE_DAYS, load_campaigns, load_todos, parse_time, read_json, todo_status  # noqa: E402
from daily_report import REPORT_HEAD_RE, parse_daily_report, read_jsonl  # noqa: E402,F401

SCHEMA_VERSION = 1



# ---------------------------------------------------------------------------
# 원문
# ---------------------------------------------------------------------------


def load_messages(data_dir: Path, live_path: Path | None) -> tuple[list[dict], dict]:
    """예약 원문 + 실시간 원문을 msg_id 로 합친다. 예약 원문이 정본이다 — 같은 msg_id 면 그쪽을 쓴다."""
    out, seen = [], set()
    files = sorted((data_dir / "raw").glob("*/*.jsonl"))
    for f in files:
        dm = "__dm_" in f.name
        for r in read_jsonl(f):
            mid = r.get("msg_id")
            if mid:
                if mid in seen:
                    continue
                seen.add(mid)
            out.append(_message(r, dm=dm, live=False))
    live = 0
    for r in read_jsonl(live_path) if live_path else []:
        mid = r.get("msg_id")
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append(_message(r, dm=False, live=True))
        live += 1
    out.sort(key=lambda m: (m["ts"] or "", m["id"] or ""))
    return out, {"raw_files": len(files), "messages": len(out), "live_messages": live}


def _message(r: dict, dm: bool, live: bool) -> dict:
    return {
        "id": r.get("msg_id"),
        "ts": r.get("ts"),
        "date": r.get("date"),
        "room": r.get("room") or "?",
        "author": r.get("author") or "?",
        "type": r.get("msg_type"),
        "text": r.get("text") or "",
        "thread": r.get("thread_id"),
        "dm": dm,
        "live": live,
        "files": len(r.get("files") or []) if isinstance(r.get("files"), list) else 0,
    }


# ---------------------------------------------------------------------------
# 리포트
# ---------------------------------------------------------------------------


def _title(path: Path) -> str:
    try:
        with path.open(encoding="utf-8") as f:
            for line in f:
                if line.startswith("# "):
                    return line[2:].strip()
    except OSError:
        pass
    return path.stem


def index_reports(briefs_dir: Path) -> list[dict]:
    items = []

    def add(kind: str, path: Path, date: str | None):
        items.append({"id": str(path.relative_to(briefs_dir)), "kind": kind, "date": date, "title": _title(path)})

    for p in briefs_dir.glob("lark_daily_brief_*.md"):
        m = re.search(r"(\d{4})(\d{2})(\d{2})", p.name)
        add("brief", p, f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None)
    for p in briefs_dir.glob("daily_brief_*.md"):
        m = re.search(r"(\d{4})(\d{2})(\d{2})", p.name)
        add("brief", p, f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None)
    reports = briefs_dir / "reports"
    for p in reports.glob("*/*_daily.md"):
        add("daily", p, p.name[:10])
    for p in reports.glob("*/_weekly.md"):
        add("weekly", p, p.parent.name)
    for p in (reports / "_monthly").glob("*.md"):
        add("monthly", p, p.stem[:7])
    for p in (reports / "_analysis").glob("*.md"):
        add("analysis", p, None)
    for p in briefs_dir.glob("lark_monthly_*.md"):
        add("monthly", p, re.sub(r"^lark_monthly_", "", p.stem))
    order = {"analysis": 0, "monthly": 1, "weekly": 2, "brief": 3, "daily": 4}
    items.sort(key=lambda r: (order[r["kind"]], r["date"] or ""), reverse=False)
    return sorted(items, key=lambda r: (r["date"] or "0000"), reverse=True)


def latest_decisions(briefs_dir: Path) -> dict | None:
    """가장 최근 로컬 브리핑의 '## 오늘 결정할 것' 절 — Syn 이 관리자에게 답할 때 쓴다."""
    briefs = sorted(briefs_dir.glob("lark_daily_brief_*.md"))
    if not briefs:
        return None
    path = briefs[-1]
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^## 오늘 결정할 것\s*$(.*?)(?=^## )", text, re.M | re.S)
    items = re.findall(r"^### (.+)$", m.group(1), re.M) if m else []
    return {"source": path.name, "title": _title(path), "items": items}


# ---------------------------------------------------------------------------
# 조립
# ---------------------------------------------------------------------------


def build_insights(data_dir: Path, briefs_dir: Path, roster: dict | None, live_path: Path | None, now: dt.datetime) -> dict:
    messages, coverage = load_messages(data_dir, live_path)
    hits: dict = {}
    todos = load_todos(data_dir, now, hits)
    for t in todos:  # 사무실 보드와 같은 규칙(build_office.todo_status) — 규칙은 한 곳에만
        t["board_status"] = todo_status(t)
        t["stale"] = t["board_status"] in {"todo", "review", "blocked"} and (t["age_days"] or 0) >= STALE_DAYS
    campaigns = load_campaigns(data_dir, hits)
    people_raw = (read_json(data_dir / "people.json") or {}).get("people") or {}
    roster_names = {m["name"] for m in (roster or {}).get("members", [])}

    persons: dict[str, dict] = {}

    def person(name: str) -> dict:
        if name not in persons:
            layers = people_raw.get(name) if isinstance(people_raw.get(name), dict) else {}
            persons[name] = {
                "name": name,
                "in_roster": name in roster_names,
                "stats": {"messages": 0, "rooms": {}, "first": None, "last": None, "by_month": {}},
                "daily_reports": [],
                "todos": [],
                "campaigns": [],
                "L1": layers.get("L1") if isinstance(layers.get("L1"), dict) else {},
                # L1 밖의 층(L2 패턴·L3 성격 추론 등) — 관리자 화면에서만. 추론·미검증이다.
                "local_layers": {k: v for k, v in layers.items() if k != "L1"},
            }
        return persons[name]

    for n in roster_names:
        person(n)
    for n in people_raw:
        person(n)

    rooms: dict[str, dict] = {}
    for m in messages:
        r = rooms.setdefault(m["room"], {"name": m["room"], "count": 0, "first": m["date"], "last": m["date"], "dm": m["dm"]})
        r["count"] += 1
        r["last"] = max(r["last"] or "", m["date"] or "") or None
        if m["type"] == "system" or m["author"] in {"?", "system"}:
            continue
        p = person(m["author"])
        s = p["stats"]
        s["messages"] += 1
        s["rooms"][m["room"]] = s["rooms"].get(m["room"], 0) + 1
        s["first"] = min(filter(None, [s["first"], m["date"]]), default=None)
        s["last"] = max(filter(None, [s["last"], m["date"]]), default=None)
        month = (m["date"] or "")[:7]
        if month:
            s["by_month"][month] = s["by_month"].get(month, 0) + 1
        report = parse_daily_report(m["text"])
        if report:
            p["daily_reports"].append({"date": m["date"], "ts": m["ts"], "room": m["room"], "msg_id": m["id"], **report})

    alias = {n.lower(): n for n in persons}
    for t in todos:
        owner = alias.get((t.get("owner") or "").lower())
        if owner:
            persons[owner]["todos"].append(t["id"])
    for c in campaigns:
        for o in c["owners"]:
            owner = alias.get(o.lower())
            if owner and c["name"] not in persons[owner]["campaigns"]:
                persons[owner]["campaigns"].append(c["name"])

    for p in persons.values():
        p["daily_reports"].sort(key=lambda r: r["ts"] or "", reverse=True)
        p["stats"]["rooms"] = dict(sorted(p["stats"]["rooms"].items(), key=lambda kv: -kv[1]))

    unresolved = sorted(n for n in persons if n.startswith("user:") or n == "?")
    dashboards = {
        k: str(p.relative_to(briefs_dir))
        for k, p in (("full", briefs_dir / "dashboard" / "lark_dashboard.html"), ("share", briefs_dir / "dashboard" / "lark_dashboard_share.html"))
        if p.exists()
    }
    return {
        "schema": SCHEMA_VERSION,
        "generated_at": now.isoformat(timespec="seconds"),
        "persons": dict(sorted(persons.items())),
        "rooms": dict(sorted(rooms.items(), key=lambda kv: kv[1]["last"] or "", reverse=True)),
        "messages": messages,
        "todos": {t["id"]: t for t in todos},
        "reports": index_reports(briefs_dir),
        "decisions": latest_decisions(briefs_dir),
        "dashboards": dashboards,
        "coverage": {**coverage, "unresolved_authors": unresolved},
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--briefs-dir", type=Path, help="기본: <data-dir>/..")
    ap.add_argument("--roster", type=Path)
    ap.add_argument("--live", type=Path, help="lark_live.py 실시간 원문 (out/live/messages.jsonl)")
    ap.add_argument("--out", type=Path, default=Path("out/insights.json"))
    ap.add_argument("--now")
    args = ap.parse_args(argv)
    data_dir = args.data_dir.expanduser()
    if not data_dir.is_dir():
        print(f"✗ 데이터 폴더가 없다: {data_dir}", file=sys.stderr)
        return 2
    briefs_dir = (args.briefs_dir or data_dir.parent).expanduser()
    roster = read_json(args.roster) if args.roster and args.roster.exists() else None
    now = parse_time(args.now) if args.now else dt.datetime.now(KST)
    insights = build_insights(data_dir, briefs_dir, roster, args.live, now)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(insights, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(args.out)
    c = insights["coverage"]
    reports = sum(1 for p in insights["persons"].values() for _ in p["daily_reports"])
    print(
        f"✓ {args.out} · 원문 {c['messages']}건(실시간 {c['live_messages']}) · 사람 {len(insights['persons'])} · "
        f"일일보고 {reports} · 리포트 {len(insights['reports'])}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
