"""외부 연결 차단기(Python) — FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다(2026-09-28 Dylan 결정).

명단 수집기(lark_roster.py)와 실시간 데몬(lark_live.py)은 원천인 Lark 에만 닿는다. 그 밖의 목적지는
**이름 풀이(getaddrinfo) 단계에서** 거절한다 — urllib·http.client·asyncio·websockets 가 모두 여기를 지나므로,
라이브러리(lark-oapi 등)가 무엇을 더하든 Lark 와 이 Mac 말고는 연결이 열리지 않는다. 호스트 이름도 바깥 DNS 로
나가지 않는다.

허용: localhost·루프백 · *.larksuite.com(Lark 국제판 API·장기 연결) · FAMIGO_EGRESS_ALLOW(쉼표)
"""

from __future__ import annotations

import ipaddress
import os
import socket
import sys

LARK_SUFFIXES = (".larksuite.com",)
_installed = False
_reported: set[str] = set()


def is_allowed(host) -> bool:
    if host is None:
        return True  # 자기 자신에 바인딩(서버 소켓)
    h = host.decode() if isinstance(host, bytes) else str(host)
    h = h.strip("[]").lower()
    if h in {"localhost", ""} or h.endswith(".localhost"):
        return True
    extra = {x.strip().lower() for x in os.environ.get("FAMIGO_EGRESS_ALLOW", "").split(",") if x.strip()}
    if h in extra:
        return True
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_loopback or ip.is_unspecified
    except ValueError:
        pass
    return h == LARK_SUFFIXES[0].lstrip(".") or h.endswith(LARK_SUFFIXES)


def install() -> None:
    """socket.getaddrinfo 를 감싼다. 한 번만."""
    global _installed
    if _installed:
        return
    original = socket.getaddrinfo

    def guarded(host, *args, **kwargs):
        if not is_allowed(host):
            key = str(host)
            if key not in _reported:
                _reported.add(key)
                print(f"[egress-guard] 차단: {key} (FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다)", file=sys.stderr, flush=True)
            raise socket.gaierror(socket.EAI_NONAME, f"egress blocked: {host}")
        return original(host, *args, **kwargs)

    socket.getaddrinfo = guarded
    _installed = True
