#!/usr/bin/env python3
"""Lark API → 실제 구성원 명단(out/lark_roster.json).

왜: people.json 은 브리핑이 표본을 쌓은 사람만 담는다. 사무실 직원은 **지금 Lark 에 있는 사람 전원**
이어야 한다. 커스텀 앱 famigo_larkchat 이 들어가 있는 내부 방들의 구성원을 합치면 그게 명단이다.

경계 (lark-daily-brief §0):
  - 읽기 전용 GET 만 쓴다. 메시지는 읽지 않는다 — 방 목록과 구성원 이름만.
  - 자격증명은 Mac 의 ~/.config/famigo/lark_credentials.json 을 읽기만 한다. 어디에도 쓰거나 출력하지 않는다.
  - 봇 방(`봇`·`chatbot`)과 외부 방(external)은 건너뛴다. 외부사 담당자 실명은 명단에 들어가지 않는다.
  - open_id 원문은 저장하지 않는다(중복 판정용 해시만).

API 근거 (larksuite/oapi-sdk-python):
  POST /open-apis/auth/v3/tenant_access_token/internal {app_id, app_secret} → tenant_access_token, expire
  GET  /open-apis/im/v1/chats?page_size&page_token → data.items[chat_id,name,external,tenant_key,chat_status], has_more, page_token
  GET  /open-apis/im/v1/chats/:chat_id/members?member_id_type=open_id → data.items[member_id,name,tenant_key], has_more, page_token
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_DOMAIN = "https://open.larksuite.com"
BOT_ROOM_RE = re.compile(r"봇|chatbot", re.I)
STAGE_RE = re.compile(r"^\s*(준비중|진행중|대기|종료|Cancel|완료)(\([^)]*\))?\s*[-–—:]?\s*", re.I)
KST = dt.timezone(dt.timedelta(hours=9))


class LarkError(RuntimeError):
    pass


QUOTA_EXCEEDED = 99991403  # "This month's API call quota has been exceeded"


def _error_code(e) -> int | None:
    """HTTP 오류 본문의 Lark code (없으면 None)."""
    try:
        return json.loads(e.read().decode()).get("code")
    except Exception:
        return None


def load_credentials(path: Path) -> tuple[str, str, str]:
    if not path.exists():
        raise LarkError(f"자격증명 파일이 없다: {path}")
    creds = json.loads(path.read_text(encoding="utf-8"))
    app_id = creds.get("app_id") or creds.get("APP_ID") or creds.get("appId")
    secret = creds.get("app_secret") or creds.get("APP_SECRET") or creds.get("appSecret")
    if not app_id or not secret:
        raise LarkError(f"{path.name} 에 app_id/app_secret 키가 없다 (있는 키: {sorted(creds)})")
    domain = creds.get("domain") or creds.get("base_url") or DEFAULT_DOMAIN
    return app_id, secret, domain.rstrip("/")


class LarkClient:
    """meter: office/lark_meter.CallMeter — 모든 호출(재시도 포함)이 월 한도·하루 예산을 지난다."""

    def __init__(self, domain: str, app_id: str, app_secret: str, opener=urllib.request.urlopen, meter=None):
        self.domain, self.app_id, self.app_secret, self.opener, self.meter = domain, app_id, app_secret, opener, meter
        self.token = None

    def _call(self, method: str, path: str, params=None, body=None, auth=True):
        url = self.domain + path + ("?" + urllib.parse.urlencode(params) if params else "")
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            if self.meter is not None:
                try:
                    self.meter.take(f"{method} {path}")
                except Exception as e:
                    raise LarkError(str(e)) from e
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with self.opener(req, timeout=30) as res:
                    payload = json.loads(res.read().decode())
            except urllib.error.HTTPError as e:
                code = _error_code(e)
                if code == QUOTA_EXCEEDED:
                    # 월 한도 초과 — 재시도는 한도를 더 쓸 뿐이다. 다음 달까지 막고 멈춘다.
                    until = self.meter.quota_exceeded() if self.meter is not None else "다음 달"
                    raise LarkError(f"{method} {path} → code={QUOTA_EXCEEDED} 월 API 호출 한도 초과 — {until} 까지 호출 중단") from e
                if e.code == 429 and attempt < 3:
                    time.sleep(2**attempt)
                    continue
                raise LarkError(f"{method} {path} → HTTP {e.code}") from e
            code = payload.get("code", 0)
            if code == QUOTA_EXCEEDED:
                until = self.meter.quota_exceeded() if self.meter is not None else "다음 달"
                raise LarkError(f"{method} {path} → code={QUOTA_EXCEEDED} 월 API 호출 한도 초과 — {until} 까지 호출 중단")
            if code == 99991400 and attempt < 3:  # 빈도 제한
                time.sleep(2**attempt)
                continue
            if code != 0:
                raise LarkError(f"{method} {path} → code={code} {payload.get('msg', '')}")
            return payload
        raise LarkError(f"{method} {path} → 재시도 초과")

    def authenticate(self):
        payload = self._call(
            "POST",
            "/open-apis/auth/v3/tenant_access_token/internal",
            body={"app_id": self.app_id, "app_secret": self.app_secret},
            auth=False,
        )
        self.token = payload["tenant_access_token"]

    def paged(self, path: str, params: dict):
        token = None
        while True:
            q = dict(params, page_size=100, **({"page_token": token} if token else {}))
            data = self._call("GET", path, q).get("data") or {}
            yield from data.get("items") or []
            if not data.get("has_more"):
                return
            token = data.get("page_token")
            if not token:
                return

    def chats(self):
        return self.paged("/open-apis/im/v1/chats", {})

    def members(self, chat_id: str):
        return self.paged(f"/open-apis/im/v1/chats/{urllib.parse.quote(chat_id)}/members", {"member_id_type": "open_id"})


def _title(name: str) -> str:
    m = STAGE_RE.match(name)
    return name[m.end():].strip() if m else name


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def assemble(rooms: list[dict], names: dict[str, str]) -> list[dict]:
    """방별 구성원(rooms[].members) → 사람별 참여 방 목록. 한 방에서 빠진 사람은 그 방 제목이 사라지고,
    어느 방에도 없으면 명단에서 빠진다."""
    rooms_of: dict[str, set[str]] = {}
    for r in rooms:
        for key in r.get("members", []):
            rooms_of.setdefault(key, set()).add(_title(r["name"]))
    members = [{"id": k, "name": names[k], "rooms": sorted(t for t in titles if t)} for k, titles in rooms_of.items() if k in names]
    members.sort(key=lambda p: (-len(p["rooms"]), p["name"]))
    return members


def _room_entry(chat: dict, name: str) -> dict:
    return {"chat_id": chat.get("chat_id"), "name": name, "external": bool(chat.get("external"))}


def build_roster(client: LarkClient, now: dt.datetime) -> dict:
    """전체 수집 — 방 목록 + 내부 방마다 구성원. 호출이 많다(방 수만큼) — 주 1회·설치 때만."""
    client.authenticate()
    skipped = collections.Counter()
    tenants = collections.Counter()
    rooms, raw_members = [], {}  # chat_id → [(key, name, tenant)]
    for chat in client.chats():
        name = (chat.get("name") or "").strip()
        if BOT_ROOM_RE.search(name):
            skipped["bot"] += 1
            continue
        if chat.get("chat_status") not in (None, "normal"):
            skipped["not_normal"] += 1
            continue
        rooms.append(_room_entry(chat, name))
        if chat.get("external"):
            skipped["external"] += 1  # 외부 방은 이름까지만 — 구성원은 보지 않는다 (§0.4)
            continue
        found = []
        for m in client.members(chat["chat_id"]):
            member_name, mid = (m.get("name") or "").strip(), m.get("member_id")
            if member_name and mid:
                found.append((_hash(mid), member_name, m.get("tenant_key")))
                tenants[m.get("tenant_key")] += 1
        raw_members[chat["chat_id"]] = found
    # 내부 방에 외부 테넌트가 섞여 있으면 뺀다 — 가장 많은 테넌트가 우리다. 원문 대신 해시만 남긴다.
    home = tenants.most_common(1)[0][0] if tenants else None
    names, foreign = {}, set()
    for r in rooms:
        keys = []
        for key, member_name, tenant in raw_members.get(r["chat_id"], []):
            if home is not None and tenant != home:
                foreign.add(key)
                continue
            names[key] = member_name
            keys.append(key)
        if not r["external"]:
            r["members"] = sorted(set(keys))
    if foreign:
        skipped["foreign_member"] = len(foreign)
    return {
        "schema": 2,
        "source": "lark-api",
        "generated_at": now.isoformat(timespec="seconds"),
        "full_at": now.isoformat(timespec="seconds"),
        "home_tenant": _hash(home) if home else None,
        "chats_seen": sum(1 for r in rooms if not r["external"]),
        "chats_skipped": dict(skipped),
        "names": names,
        "members": assemble(rooms, names),
        "rooms": rooms,
    }


def refresh_chats(client: LarkClient, roster: dict, chat_ids: list[str], drop: list[str], now: dt.datetime) -> dict:
    """이벤트가 가리킨 방만 다시 읽는다 (구성원 변화·이름 변경). 방마다 정보 1호출 + 구성원 1호출 남짓.
    drop: 해산된 방 — 호출 없이 뺀다."""
    if roster.get("schema") != 2:
        raise LarkError("명단이 옛 형식이다 — 전체 수집(bash scripts/office.sh roster)을 한 번 돌린다")
    rooms = [r for r in roster["rooms"] if r["chat_id"] not in set(drop)]
    names = dict(roster.get("names", {}))
    by_id = {r["chat_id"]: r for r in rooms}
    if chat_ids:
        client.authenticate()
    for chat_id in chat_ids:
        chat = (client._call("GET", f"/open-apis/im/v1/chats/{urllib.parse.quote(chat_id)}").get("data") or {})
        name = (chat.get("name") or "").strip()
        if BOT_ROOM_RE.search(name) or chat.get("chat_status") not in (None, "normal"):
            by_id.pop(chat_id, None)
            continue
        entry = _room_entry({**chat, "chat_id": chat_id}, name)
        if not entry["external"]:
            keys = []
            for m in client.members(chat_id):
                member_name, mid = (m.get("name") or "").strip(), m.get("member_id")
                if not member_name or not mid:
                    continue
                if roster.get("home_tenant") and _hash(m.get("tenant_key") or "") != roster["home_tenant"]:
                    continue  # 다른 회사 사람 — 명단에 넣지 않는다
                names[_hash(mid)] = member_name
                keys.append(_hash(mid))
            entry["members"] = sorted(set(keys))
        by_id[chat_id] = entry
    rooms = list(by_id.values())
    return {
        **roster,
        "generated_at": now.isoformat(timespec="seconds"),
        "chats_seen": sum(1 for r in rooms if not r["external"]),
        "names": names,
        "members": assemble(rooms, names),
        "rooms": rooms,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--credentials", type=Path, default=Path("~/.config/famigo/lark_credentials.json").expanduser())
    ap.add_argument("--out", type=Path, default=Path("out/lark_roster.json"))
    ap.add_argument("--chats", default="", help="이 방들만 다시 읽는다 (쉼표) — 이벤트가 가리킨 방")
    ap.add_argument("--drop", default="", help="해산된 방 (쉼표) — 호출 없이 뺀다")
    ap.add_argument("--force", action="store_true", help="최근 전체 수집이 있어도 다시 모은다")
    ap.add_argument("--max-age-hours", type=float, default=24.0, help="이보다 최근 전체 수집이면 다시 모으지 않는다 (호출 0)")
    args = ap.parse_args(argv)
    # FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다 — Lark 와 이 Mac 말고는 이름 풀이부터 막는다(office/egress.py).
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import egress

    egress.install()
    try:
        from lark_meter import CallMeter

        app_id, secret, domain = load_credentials(args.credentials.expanduser())
        client = LarkClient(domain, app_id, secret, meter=CallMeter(args.out.parent / "lark_calls.json"))
        chats = [c for c in args.chats.split(",") if c]
        drop = [c for c in args.drop.split(",") if c]
        previous_full = None
        if args.out.exists() and not (chats or drop) and not args.force:
            try:
                previous_full = json.loads(args.out.read_text(encoding="utf-8")).get("full_at")
            except ValueError:
                previous_full = None
        if previous_full and (dt.datetime.now(KST) - dt.datetime.fromisoformat(previous_full)).total_seconds() < args.max_age_hours * 3600:
            # 전체 수집은 방 수만큼 호출한다(약 75) — 재설치·수동 실행이 월 한도를 먹지 않게(2026-09-28 사고).
            print(f"✓ {args.out} · 최근 전체 수집({previous_full}) 사용 — Lark 호출 0 (다시 모으려면 --force)")
            return 0
        if chats or drop:
            previous = json.loads(args.out.read_text(encoding="utf-8")) if args.out.exists() else None
            if previous is None:
                raise LarkError("기존 명단이 없다 — 전체 수집부터")
            roster = refresh_chats(client, previous, chats, drop, dt.datetime.now(KST))
        else:
            roster = build_roster(client, dt.datetime.now(KST))
    except LarkError as e:
        print(f"✗ {e}", file=sys.stderr)
        if "99991672" in str(e):
            print("  → 스코프 부족: 앱에 im:chat:readonly (또는 im:chat) 추가 후 Release 까지 해야 한다", file=sys.stderr)
        return 2
    if not roster["members"]:
        # 0명은 성공이 아니다 — 옛 명단을 덮어쓰지 않는다.
        print(f"✗ 구성원 0명 (방 {roster['chats_seen']}개, 건너뜀 {roster['chats_skipped']}) — 기존 명단 유지", file=sys.stderr)
        return 3
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(".tmp")
    tmp.write_text(json.dumps(roster, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(args.out)
    kind = f"방 {len(chats)}곳 갱신" if (chats or drop) else "전체 수집"
    print(f"✓ {args.out} · {kind} · 구성원 {len(roster['members'])}명 · 내부 방 {roster['chats_seen']} · 건너뜀 {roster['chats_skipped']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
