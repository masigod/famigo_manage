#!/usr/bin/env python3
"""Lark 데이터층 → DeskRPG 오피스 모델(office.json).

왜: DeskRPG 는 Hermes 게이트웨이를 통해서만 직원·칸반을 본다. 이 스크립트는 아울러스 Lark
브리핑 파이프라인이 이미 쌓아 둔 데이터층(`briefs/data/`)을 읽어, famigo 게이트웨이
(`gateway/server.mjs`)가 서빙할 **정규화된 오피스 모델** 하나로 만든다.

경계 (lark-daily-brief §0 승계):
  - 읽기 전용. 원천 파일을 절대 쓰지 않는다.
  - people.json 은 **L1 허용 목록 필드만** 읽는다. L2(패턴)·L3(성격 추론)는 키째 무시한다.
  - DM(`dm_*`)·봇 방(`봇`·`chatbot`)은 통째로 제외한다.
  - 산출물 전체를 `lark_store.export_for_slack()` 게이트에 통과시킨다. 게이트를 못 찾으면
    **실패로 멈춘다(fail-closed).** `--allow-no-gate` 는 합성 픽스처 테스트 전용이다.

사용:
  python3 office/build_office.py --data-dir ~/famigo_campaign/briefs/data \
      --config config/office.config.json --out out/office.json
  python3 office/build_office.py --data-dir ... --doctor   # 원천 스키마 점검만
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

SCHEMA_VERSION = 1
KST = dt.timezone(dt.timedelta(hours=9))

# 방 이름 접두사가 캠페인 상태다 (lark-daily-brief §3.2).
STAGE_RE = re.compile(r"^\s*(준비중|진행중|대기|종료|Cancel|완료)(\([^)]*\))?\s*[-–—:]?\s*", re.I)
STAGE_TO_STATUS = {
    "준비중": "scheduled",
    "진행중": "running",
    "대기": "blocked",
    "종료": "done",
    "완료": "done",
    "cancel": "archived",
}
ZOMBIE_DAYS = 21  # §5: 진행중·준비중인데 21일 이상 조용
STALE_DAYS = 7  # §4.5: 7일+ → stale

BOT_ROOM_RE = re.compile(r"봇|chatbot", re.I)

# 필드 후보 — 원천 스키마를 이 저장소가 소유하지 않으므로 후보 목록으로 읽고,
# 무엇이 실제로 맞았는지 --doctor 가 보고한다. 추측으로 채우지 않는다.
TODO_FIELDS = {
    "id": ["id", "todo_id", "key", "tid"],
    "title": ["title", "summary", "text", "what", "subject"],
    "kind": ["kind", "type", "category"],
    "status": ["status", "state"],
    "age_days": ["age_days", "days_open", "age", "elapsed_days"],
    "opened": ["opened", "created", "created_at", "first_seen", "date", "since"],
    "room": ["room", "room_name", "room_slug", "source_room", "chat"],
    "owner": ["owner", "assignee", "who", "person", "담당"],
    "campaign": ["campaign", "campaign_name", "project"],
    "due": ["due", "deadline"],
}
PERSON_L1_FIELDS = {
    "name": ["display_name", "name", "nickname", "alias"],
    "role": ["role", "title", "position", "job", "직무"],
    "team": ["team", "department", "dept", "area", "팀"],
    "aliases": ["aliases", "alias_names", "names"],
    "active": ["active", "is_active", "employed"],
    "last_active": ["last", "last_seen", "last_active"],
    "reports": ["reports", "report_count"],
}
ROOM_FIELDS = {
    "id": ["chat_id", "id", "room_id"],
    "name": ["name", "room_name", "title"],
    "external": ["external", "is_external", "외부"],
    "last_human": ["last_human_at", "last_human", "last_seen", "last_activity", "last_message_at"],
    "kind": ["kind", "type", "chat_type"],
    "campaign": ["campaign", "campaign_name"],
}
CAMPAIGN_FIELDS = {
    "name": ["name", "campaign", "title"],
    "room": ["room", "room_name", "chat_id"],
    "owner": ["owner", "lead", "manager", "담당"],
    "owners": ["owners"],
    "status": ["status"],
    "idle_days": ["idle_days"],
    "launch": ["launch", "start"],
    "end": ["end"],
    "seen_in": ["seen_in", "rooms"],
    "wbs": ["wbs"],
}
DAILY_FIELDS_SCALAR = re.compile(r"^[a-z_]+$")

TERMINAL_DONE = {"resolved", "done", "closed", "종결", "해결"}
TERMINAL_ARCHIVED = {"closed_wrong", "superseded", "replaced", "대체됨", "cancelled", "canceled", "dropped"}


class SourceError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# 읽기
# ---------------------------------------------------------------------------


def read_json(path: Path):
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                raise SourceError(f"{path.name}:{n} JSON 파싱 실패: {e}") from e
            if isinstance(row, dict):
                rows.append(row)
    return rows


def pick(record: dict, candidates: list[str], hits: dict | None = None, slot: str = ""):
    """후보 필드 중 처음으로 값이 있는 것을 돌려준다. 0·False 는 값이다(`x or 0` 금지)."""
    for key in candidates:
        if key in record and record[key] is not None and record[key] != "":
            if hits is not None:
                hits.setdefault(slot, set()).add(key)
            return record[key]
    return None


def as_records(obj, id_key: str = "_key") -> list[dict]:
    """list / {"items": [...]} / {key: {...}} 세 모양을 레코드 목록으로 편다."""
    if obj is None:
        return []
    if isinstance(obj, list):
        return [r for r in obj if isinstance(r, dict)]
    if isinstance(obj, dict):
        # 실측(2026-09-28): 레코드가 래퍼 키 아래에 있고 옆에 `_schema`·`_manual` 같은 메타 키가 여럿 붙는다.
        for wrapper in ("items", "people", "rooms", "campaigns", "data"):
            if isinstance(obj.get(wrapper), (list, dict)):
                return as_records(obj[wrapper], id_key)
        out = []
        for k, v in obj.items():
            if isinstance(v, dict):
                out.append({id_key: k, **v})
        return out
    return []


def parse_time(value) -> dt.datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        ts = value / 1000 if value > 1e12 else value
        return dt.datetime.fromtimestamp(ts, tz=KST)
    if isinstance(value, str):
        s = value.strip().replace("Z", "+00:00")
        for fmt in (None, "%Y-%m-%d", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
            try:
                t = dt.datetime.fromisoformat(s) if fmt is None else dt.datetime.strptime(s, fmt)
                return t if t.tzinfo else t.replace(tzinfo=KST)
            except ValueError:
                continue
    return None


def days_between(then: dt.datetime | None, now: dt.datetime) -> int | None:
    if then is None:
        return None
    return max(0, (now.date() - then.astimezone(KST).date()).days)


def profile_slug(name: str, used: set[str]) -> str:
    """Hermes profile_name 규칙 `[A-Za-z0-9._-]` 에 맞춘다. 한글 이름은 해시로."""
    base = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-._")
    if not base or not re.search(r"[a-z]", base):
        base = "m-" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    slug, n = base[:40], 2
    while slug in used:
        slug = f"{base[:37]}-{n}"
        n += 1
    used.add(slug)
    return slug


# ---------------------------------------------------------------------------
# 층별 정규화
# ---------------------------------------------------------------------------


def load_people(data_dir: Path, hits: dict) -> list[dict]:
    raw = read_json(data_dir / "people.json")
    people = []
    for rec in as_records(raw):
        # L1 만. 레코드가 층으로 나뉘어 있으면 L1 블록만 본다.
        layer = rec.get("L1") or rec.get("l1")
        src = layer if isinstance(layer, dict) else rec
        name = pick(src, PERSON_L1_FIELDS["name"], hits, "person.name") or rec.get("_key")
        if not isinstance(name, str) or not name.strip():
            continue
        aliases = pick(src, PERSON_L1_FIELDS["aliases"], hits, "person.aliases")
        active = pick(src, PERSON_L1_FIELDS["active"], hits, "person.active")
        people.append(
            {
                "name": name.strip(),
                "role": _str(pick(src, PERSON_L1_FIELDS["role"], hits, "person.role")),
                "team": _str(pick(src, PERSON_L1_FIELDS["team"], hits, "person.team")),
                "aliases": [a for a in aliases if isinstance(a, str)] if isinstance(aliases, list) else [],
                "active": active if isinstance(active, bool) else None,
                "last_active": _str(pick(src, PERSON_L1_FIELDS["last_active"], hits, "person.last_active")),
                "reports": _int(pick(src, PERSON_L1_FIELDS["reports"], hits, "person.reports")),
            }
        )
    return people


def load_rooms(data_dir: Path, now: dt.datetime, hits: dict, api_rooms: list[dict] | None = None) -> list[dict]:
    """방 레지스트리. Lark API 방 목록(api_rooms)이 있으면 **그 이름이 상태의 정본**이고,
    rooms.json 은 마지막 사람 발화 시각(조용한 기간)을 잇는 데만 쓴다 (chat_id → 이름 순으로 매칭)."""
    local = []
    for rec in as_records(read_json(data_dir / "rooms.json")):
        name = _str(pick(rec, ROOM_FIELDS["name"], hits, "room.name") or rec.get("_key"))
        if not name:
            continue
        local.append(
            {
                "id": _str(pick(rec, ROOM_FIELDS["id"], hits, "room.id")),
                "name": name,
                "kind": _str(pick(rec, ROOM_FIELDS["kind"], hits, "room.kind")) or "",
                "external": pick(rec, ROOM_FIELDS["external"], hits, "room.external"),
                "last": parse_time(pick(rec, ROOM_FIELDS["last_human"], hits, "room.last_human")),
                "campaign": _str(pick(rec, ROOM_FIELDS["campaign"], hits, "room.campaign")),
            }
        )
    by_id = {r["id"]: r for r in local if r["id"]}
    by_name = {}
    for r in local:
        by_name.setdefault(r["name"], r)
        m = STAGE_RE.match(r["name"])
        by_name.setdefault(r["name"][m.end():].strip() if m else r["name"], r)

    if api_rooms:
        source = []
        for a in api_rooms:
            name = _str(a.get("name"))
            if not name:
                continue
            m = STAGE_RE.match(name)
            title = name[m.end():].strip() if m else name
            match = by_id.get(a.get("chat_id")) or by_name.get(name) or by_name.get(title) or {}
            source.append(
                {"id": a.get("chat_id") or name, "name": name, "kind": match.get("kind", ""),
                 "external": a.get("external"), "last": match.get("last"), "campaign": match.get("campaign")}
            )
    else:
        source = [dict(r, id=r["id"] or r["name"]) for r in local]

    rooms = []
    for r in source:
        name = r["name"]
        if BOT_ROOM_RE.search(name) or r["kind"].lower() in {"p2p", "dm", "bot"} or name.startswith("dm_"):
            continue  # §0.2 봇 방 · DM 전면 제외
        m = STAGE_RE.match(name)
        rooms.append(
            {
                "id": r["id"],
                "name": name,
                "title": (name[m.end():].strip() if m else name) or name,
                "stage": m.group(1) if m else None,
                "stage_note": m.group(2).strip("()") if m and m.group(2) else None,
                "external": bool(r["external"]) if r["external"] is not None else False,
                "quiet_days": days_between(r["last"], now),  # None = 미확인. 0 과 다르다.
                "campaign": r.get("campaign"),
            }
        )
    return rooms


def load_todos(data_dir: Path, now: dt.datetime, hits: dict) -> list[dict]:
    """todos.jsonl 은 append-only 전이 로그다. 행이 아니라 **키**를 센다 — 같은 id 의 뒤 행이 앞 행을 덮는다."""
    latest: dict[str, dict] = {}
    order: list[str] = []
    for row in read_jsonl(data_dir / "todos.jsonl"):
        tid = _str(pick(row, TODO_FIELDS["id"], hits, "todo.id"))
        if not tid:
            continue
        if tid not in latest:
            order.append(tid)
            latest[tid] = {}
        latest[tid].update({k: v for k, v in row.items() if v is not None})
    todos = []
    for tid in order:
        row = latest[tid]
        opened = parse_time(pick(row, TODO_FIELDS["opened"], hits, "todo.opened"))
        age = pick(row, TODO_FIELDS["age_days"], hits, "todo.age_days")
        age = int(age) if isinstance(age, (int, float)) else days_between(opened, now)
        room = _str(pick(row, TODO_FIELDS["room"], hits, "todo.room"))
        if room and (BOT_ROOM_RE.search(room) or room.startswith("dm_")):
            continue
        todos.append(
            {
                "id": tid,
                "title": _str(pick(row, TODO_FIELDS["title"], hits, "todo.title")) or tid,
                "kind": (_str(pick(row, TODO_FIELDS["kind"], hits, "todo.kind")) or "").lower() or None,
                "status": (_str(pick(row, TODO_FIELDS["status"], hits, "todo.status")) or "open").lower(),
                "age_days": age,
                "room": room,
                "owner": _str(pick(row, TODO_FIELDS["owner"], hits, "todo.owner")),
                "campaign": _str(pick(row, TODO_FIELDS["campaign"], hits, "todo.campaign")),
                "due": _str(pick(row, TODO_FIELDS["due"], hits, "todo.due")),
            }
        )
    return todos


def load_campaigns(data_dir: Path, hits: dict) -> list[dict]:
    """campaigns.json — 사람이 `_manual.exclude` 로 뺀 것(오탐)은 캠페인이 아니다.
    WBS 는 **건수와 마지막 날짜만** 옮긴다: 원문 줄 노출은 T079 에서 Dylan 판단 대기다."""
    raw = read_json(data_dir / "campaigns.json")
    manual = raw.get("_manual", {}) if isinstance(raw, dict) else {}
    excluded = set(manual.get("exclude") or []) if isinstance(manual, dict) else set()
    out = []
    for rec in as_records(raw):
        name = _str(pick(rec, CAMPAIGN_FIELDS["name"], hits, "campaign.name") or rec.get("_key"))
        if not name or name in excluded:
            continue
        owners = pick(rec, CAMPAIGN_FIELDS["owners"], hits, "campaign.owners")
        owner = _str(pick(rec, CAMPAIGN_FIELDS["owner"], hits, "campaign.owner"))
        wbs = pick(rec, CAMPAIGN_FIELDS["wbs"], hits, "campaign.wbs")
        wbs = [w for w in wbs if isinstance(w, dict)] if isinstance(wbs, list) else []
        seen = pick(rec, CAMPAIGN_FIELDS["seen_in"], hits, "campaign.seen_in")
        out.append(
            {
                "name": name,
                "owners": [o for o in ([owner] if owner else []) + (owners if isinstance(owners, list) else []) if isinstance(o, str)],
                "status": _str(pick(rec, CAMPAIGN_FIELDS["status"], hits, "campaign.status")),
                "idle_days": _int(pick(rec, CAMPAIGN_FIELDS["idle_days"], hits, "campaign.idle_days")),
                "launch": _str(pick(rec, CAMPAIGN_FIELDS["launch"], hits, "campaign.launch")),
                "end": _str(pick(rec, CAMPAIGN_FIELDS["end"], hits, "campaign.end")),
                "wbs_count": len(wbs),
                "wbs_last": max((_str(w.get("d")) or "" for w in wbs), default="") or None,
                "rooms": [x for x in seen if isinstance(x, str)] if isinstance(seen, list) else [],
                "room": _str(pick(rec, CAMPAIGN_FIELDS["room"], hits, "campaign.room")),
            }
        )
    return out


def load_daily(data_dir: Path) -> dict | None:
    rows = read_jsonl(data_dir / "lark_daily.jsonl")
    if not rows:
        return None
    last = rows[-1]
    # 스칼라 수치·날짜·상태만. 본문·이름·목록은 가져오지 않는다.
    out = {}
    for k, v in last.items():
        if not DAILY_FIELDS_SCALAR.match(k):
            continue
        if isinstance(v, bool) or isinstance(v, (int, float)):
            out[k] = v
        elif k in {"date", "status", "window", "generated_at"} and isinstance(v, str):
            out[k] = v
    # 실측: 집계는 `totals` 아래 수치다. 수치만 올린다.
    totals = last.get("totals")
    if isinstance(totals, dict):
        for k, v in totals.items():
            if DAILY_FIELDS_SCALAR.match(k) and isinstance(v, (int, float)) and not isinstance(v, bool):
                out.setdefault(k, v)
    return out


# ---------------------------------------------------------------------------
# 오피스 모델 조립
# ---------------------------------------------------------------------------


def todo_status(todo: dict) -> str:
    s, kind = todo["status"], todo["kind"] or ""
    if s in TERMINAL_DONE:
        return "done"
    if s in TERMINAL_ARCHIVED:
        return "archived"
    if s == "blocked" or kind == "blocked":
        return "blocked"
    if kind == "decision":
        return "review"  # 사람 결정 대기 — 리뷰 칸이 그 자리다
    return "todo"


def build_office(data_dir: Path, config: dict, now: dt.datetime, roster: dict | None = None) -> tuple[dict, dict]:
    hits: dict[str, set] = {}
    people = load_people(data_dir, hits)
    rooms = load_rooms(data_dir, now, hits, (roster or {}).get("rooms"))
    todos = load_todos(data_dir, now, hits)
    campaigns = load_campaigns(data_dir, hits)
    daily = load_daily(data_dir)

    member_cfg: dict = config.get("members", {})
    # 관리자 웹의 '퇴장'은 exclude 에 이름을 적는 것이다. include:false 도 같은 뜻.
    exclude = set(config.get("exclude", [])) | {n for n, c in member_cfg.items() if c.get("include") is False}
    used: set[str] = set()
    members = []

    def person_of(name: str) -> dict | None:
        low = name.lower()
        return next((p for p in people if low in {a.lower() for a in (p["name"], *p["aliases"])}), None)

    if roster:
        # Lark 에 지금 있는 사람 전원이 직원이다. 직무·팀은 people.json L1 에서 이름이 맞을 때만.
        entries = []
        for r in roster.get("members", []):
            p = person_of(r["name"]) or {"name": r["name"], "role": None, "team": None, "aliases": [], "active": None}
            entries.append((r, p))
        roster_names = {r["name"] for r, _ in entries}
        dropped = [p["name"] for p in people if not ({p["name"], *p["aliases"]} & roster_names)]
    else:
        entries = [(None, p) for p in people]
        dropped = []

    for r, p in entries:
        name = r["name"] if r else p["name"]
        cfg = member_cfg.get(name, {})
        if name in exclude or cfg.get("include") is False or p["active"] is False:
            continue
        # 키는 이름에서만 만든다 — 명단이 있든 없든 같은 사람은 같은 키(= 같은 NPC)가 된다.
        key = cfg.get("profile") or profile_slug(name, used)
        used.add(key)
        members.append(
            {
                "key": key,
                "display_name": cfg.get("display_name") or name,
                "role": cfg.get("role") or p["role"],
                "team": cfg.get("team") or p["team"],
                "look": cfg.get("look"),
                "aliases": sorted({name, p["name"], *p["aliases"], *cfg.get("aliases", [])}),
                "rooms": r["rooms"] if r else [],
                "last_active": p.get("last_active"),
                "reports": p.get("reports"),
                "kind": "member",
            }
        )
    for key in [m["key"] for m in members]:
        used.add(key)
    if config.get("include_syn", True):
        members.append(
            {
                "key": profile_slug("syn", used),
                "display_name": "Syn",
                "role": "브리핑 분석가 (AI)",
                "team": "Lark 브리핑",
                "look": config.get("syn_look"),
                "aliases": ["Syn", "syn"],
                "kind": "analyst",
            }
        )

    alias_to_key = {a.lower(): m["key"] for m in members for a in m["aliases"]}

    def owner_key(name: str | None) -> str | None:
        return alias_to_key.get(name.lower()) if name else None

    ledger = []
    for t in todos:
        status = todo_status(t)
        ledger.append(
            {
                "id": t["id"],
                "title": t["title"],
                "kind": t["kind"],
                "status": status,
                "source_status": t["status"],
                "age_days": t["age_days"],
                "stale": status in {"todo", "review", "blocked"}
                and t["age_days"] is not None
                and t["age_days"] >= STALE_DAYS,
                "room": t["room"],
                "due": t.get("due"),
                "assignee": owner_key(t["owner"]),
            }
        )

    def campaign_of(room: dict) -> dict | None:
        """방 ↔ 캠페인: rooms.json 의 campaign 필드 → 캠페인의 방 기록 → 이름 일치 순. 못 찾으면 None(추측 안 함)."""
        keys = {room["name"], room["title"], room["id"]}
        for c in campaigns:
            if room.get("campaign") and c["name"] == room["campaign"]:
                return c
        for c in campaigns:
            if (c["room"] and c["room"] in keys) or keys & set(c["rooms"]):
                return c
        return next((c for c in campaigns if c["name"] == room["title"]), None)

    pipeline, hygiene = [], []
    for r in rooms:
        if r["stage"] is None:
            continue  # 상시 운영방·접두사 없는 방은 파이프라인이 아니다 (집계는 counts 에)
        status = STAGE_TO_STATUS.get(r["stage"]) or STAGE_TO_STATUS[r["stage"].lower()]
        zombie = r["stage"] in {"진행중", "준비중"} and r["quiet_days"] is not None and r["quiet_days"] >= ZOMBIE_DAYS
        c = campaign_of(r)
        owner = next((k for k in map(owner_key, c["owners"]) if k), None) if c else None
        pipeline.append(
            {
                "id": r["id"],
                "title": r["title"],
                "stage": r["stage"],
                "stage_note": r["stage_note"],
                "status": status,
                "quiet_days": r["quiet_days"],
                "zombie": zombie,
                "external": r["external"],
                "assignee": owner,
                "campaign": (
                    {k: c[k] for k in ("name", "status", "launch", "end", "idle_days", "wbs_count", "wbs_last")}
                    if c
                    else None
                ),
            }
        )
        if zombie:
            hygiene.append({"room": r["title"], "stage": r["stage"], "quiet_days": r["quiet_days"]})

    counts = {
        "rooms": len(rooms),
        "rooms_with_stage": sum(1 for r in rooms if r["stage"] is not None),
        "rooms_without_stage": sum(1 for r in rooms if r["stage"] is None),
        "rooms_quiet_unknown": sum(1 for r in rooms if r["quiet_days"] is None),
        "todos": len(ledger),
        "todos_open": sum(1 for t in ledger if t["status"] in {"todo", "review", "blocked"}),
        "todos_stale": sum(1 for t in ledger if t["stale"]),
        "members": sum(1 for m in members if m["kind"] == "member"),
        "campaigns": len(campaigns),
        "pipeline_linked": sum(1 for x in pipeline if x["campaign"]),
    }

    office = {
        "schema": SCHEMA_VERSION,
        "generated_at": now.isoformat(timespec="seconds"),
        "org": {
            "name": config.get("org_name", "아울러스 · Famigo"),
            "environment": config.get("environment", "trading"),
        },
        "members": members,
        "boards": {"ledger": ledger, "pipeline": pipeline},
        "hygiene": sorted(hygiene, key=lambda h: -(h["quiet_days"] or 0)),
        "daily": daily,
        "counts": counts,
        "excluded": sorted(exclude),
        # 시더가 '관리자가 퇴장시킨 NPC' 를 알아보는 키 — 직원 키와 같은 규칙으로 만든다.
        "excluded_keys": sorted(
            {member_cfg.get(n, {}).get("profile") or profile_slug(n, set()) for n in exclude}
            | set(config.get("retire_keys", []))  # 관리자 웹에서 확정한 '퇴장 후보'
        ),
    }
    report = {
        "files": {
            name: (data_dir / name).exists()
            for name in ("people.json", "rooms.json", "todos.jsonl", "campaigns.json", "lark_daily.jsonl")
        },
        "rooms_source": "lark-api (roster)" if (roster or {}).get("rooms") else "rooms.json",
        "matched_fields": {k: sorted(v) for k, v in sorted(hits.items())},
        "roster": (
            {
                "generated_at": roster.get("generated_at"),
                "members": len(roster.get("members", [])),
                "people_json_matched": sum(1 for m in members if m["kind"] == "member" and (m["role"] or m["team"])),
                "people_json_not_in_lark": len(dropped),
            }
            if roster
            else "없음 (people.json 만 사용)"
        ),
        "counts": counts,
    }
    return office, report


# ---------------------------------------------------------------------------
# 반출 게이트
# ---------------------------------------------------------------------------


def load_gate(tools_dir: Path):
    path = tools_dir / "lark_store.py"
    if not path.exists():
        return None
    sys.path.insert(0, str(tools_dir))
    spec = importlib.util.spec_from_file_location("lark_store", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return getattr(module, "export_for_slack", None)


def apply_gate(office: dict, gate) -> dict:
    gated = gate(office)
    if not isinstance(gated, dict) or "members" not in gated or "boards" not in gated:
        raise SourceError("export_for_slack() 반환 형태가 오피스 모델이 아니다 — 게이트 계약 확인 필요")
    return gated


def _int(v) -> int | None:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=Path("~/famigo_campaign/briefs/data").expanduser())
    ap.add_argument("--tools-dir", type=Path, help="lark_store.py 위치 (기본: <data-dir>/../tools)")
    ap.add_argument("--config", type=Path, default=Path("config/office.config.json"))
    ap.add_argument("--out", type=Path, default=Path("out/office.json"))
    ap.add_argument("--roster", type=Path, default=Path("out/lark_roster.json"), help="lark_roster.py 산출물 (없으면 people.json 만)")
    ap.add_argument("--now", help="기준 시각 ISO (테스트용). 기본: 지금 KST")
    ap.add_argument("--doctor", action="store_true", help="원천 스키마 점검 결과만 출력")
    ap.add_argument("--allow-no-gate", action="store_true", help="게이트 없이 진행 (합성 픽스처 테스트 전용)")
    args = ap.parse_args(argv)

    data_dir = args.data_dir.expanduser()
    if not data_dir.is_dir():
        print(f"✗ 데이터 폴더가 없다: {data_dir}", file=sys.stderr)
        return 2
    config = read_json(args.config) if args.config.exists() else {}
    now = parse_time(args.now) if args.now else dt.datetime.now(KST)

    try:
        roster = read_json(args.roster) if args.roster and args.roster.exists() else None
        office, report = build_office(data_dir, config or {}, now, roster)
    except SourceError as e:
        print(f"✗ {e}", file=sys.stderr)
        return 2

    if args.doctor:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        missing = [k for k, ok in report["files"].items() if not ok]
        return 1 if missing else 0

    tools_dir = (args.tools_dir or data_dir.parent / "tools").expanduser()
    gate = load_gate(tools_dir)
    if gate is None:
        if not args.allow_no_gate:
            print(f"✗ 반출 게이트(lark_store.export_for_slack)를 {tools_dir} 에서 못 찾았다 — 멈춘다", file=sys.stderr)
            return 3
        office["gate"] = "none (synthetic fixture only)"
    else:
        try:
            office = apply_gate(office, gate)
        except Exception as e:  # 게이트 실패 = 반출 실패. 조용히 넘어가지 않는다.
            print(f"✗ 반출 게이트 실패: {e}", file=sys.stderr)
            return 3
        office["gate"] = "lark_store.export_for_slack"

    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(office, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(args.out)
    c = office["counts"]
    print(
        f"✓ {args.out} · 기준 {office['generated_at']} · 직원 {c['members']} · "
        f"장부 {c['todos']}(열림 {c['todos_open']}, 방치 {c['todos_stale']}) · "
        f"파이프라인 {len(office['boards']['pipeline'])} · 좀비 {len(office['hygiene'])} · 게이트 {office['gate']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
