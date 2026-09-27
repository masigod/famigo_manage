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
    def __init__(self, domain: str, app_id: str, app_secret: str, opener=urllib.request.urlopen):
        self.domain, self.app_id, self.app_secret, self.opener = domain, app_id, app_secret, opener
        self.token = None

    def _call(self, method: str, path: str, params=None, body=None, auth=True):
        url = self.domain + path + ("?" + urllib.parse.urlencode(params) if params else "")
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if auth:
            headers["Authorization"] = f"Bearer {self.token}"
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with self.opener(req, timeout=30) as res:
                    payload = json.loads(res.read().decode())
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 3:
                    time.sleep(2**attempt)
                    continue
                raise LarkError(f"{method} {path} → HTTP {e.code}") from e
            code = payload.get("code", 0)
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


def build_roster(client: LarkClient, now: dt.datetime) -> dict:
    client.authenticate()
    skipped = collections.Counter()
    seen_chats = 0
    people: dict[str, dict] = {}
    tenants = collections.Counter()
    rooms = []  # 방 레지스트리 — 이름 접두사가 캠페인 상태다 (§3.2). 원천(API)에서 동기화.
    for chat in client.chats():
        name = (chat.get("name") or "").strip()
        if BOT_ROOM_RE.search(name):
            skipped["bot"] += 1
            continue
        if chat.get("chat_status") not in (None, "normal"):
            skipped["not_normal"] += 1
            continue
        rooms.append({"chat_id": chat.get("chat_id"), "name": name, "external": bool(chat.get("external"))})
        if chat.get("external"):
            skipped["external"] += 1  # 외부 방은 이름까지만 — 구성원은 보지 않는다 (§0.4)
            continue
        seen_chats += 1
        title = name[STAGE_RE.match(name).end():].strip() if STAGE_RE.match(name) else name
        for m in client.members(chat["chat_id"]):
            member_name = (m.get("name") or "").strip()
            mid = m.get("member_id")
            if not member_name or not mid:
                continue
            key = hashlib.sha256(mid.encode()).hexdigest()[:16]
            tenants[m.get("tenant_key")] += 1
            p = people.setdefault(key, {"id": key, "name": member_name, "tenant": m.get("tenant_key"), "rooms": []})
            if title and title not in p["rooms"]:
                p["rooms"].append(title)
    # 내부 방에 외부 테넌트가 섞여 있으면 뺀다 — 가장 많은 테넌트가 우리다.
    home = tenants.most_common(1)[0][0] if tenants else None
    members = []
    for p in people.values():
        if home is not None and p["tenant"] != home:
            skipped["foreign_member"] += 1
            continue
        members.append({"id": p["id"], "name": p["name"], "rooms": sorted(p["rooms"])})
    members.sort(key=lambda p: (-len(p["rooms"]), p["name"]))
    return {
        "schema": 1,
        "source": "lark-api",
        "generated_at": now.isoformat(timespec="seconds"),
        "chats_seen": seen_chats,
        "chats_skipped": dict(skipped),
        "members": members,
        "rooms": rooms,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--credentials", type=Path, default=Path("~/.config/famigo/lark_credentials.json").expanduser())
    ap.add_argument("--out", type=Path, default=Path("out/lark_roster.json"))
    args = ap.parse_args(argv)
    try:
        app_id, secret, domain = load_credentials(args.credentials.expanduser())
        roster = build_roster(LarkClient(domain, app_id, secret), dt.datetime.now(KST))
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
    print(f"✓ {args.out} · 구성원 {len(roster['members'])}명 · 내부 방 {roster['chats_seen']} · 건너뜀 {roster['chats_skipped']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
