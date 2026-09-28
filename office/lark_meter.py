"""Lark API 호출 계량기 — 이 저장소의 모든 Lark API 호출은 여기를 지난다.

왜 (2026-09-28 사고): Lark 앱에는 **월 API 호출 한도**가 있다. 실시간 데몬이 10분마다 73개 방 구성원을
다시 모으고(1회 약 75호출 × 하루 144회) 분당 폴링까지 더해 한도를 다 써 버렸다 — code 99991403
"This month's API call quota has been exceeded". 같은 앱을 쓰는 07:00 예약 브리핑도 함께 멈춘다.
사무실은 브리핑보다 중요하지 않다. 그래서:
  - 하루 예산(기본 100호출, FAMIGO_LARK_DAILY_BUDGET)을 넘기면 호출하지 않는다.
  - 한도 초과(99991403)를 한 번 보면 다음 달 1일(KST)까지 아무것도 호출하지 않는다 — 재시도로 더 쓰지 않는다.
  - 기록: out/lark_calls.json (0600) — 월·일별 호출 수, 차단 상태. 여러 프로세스가 파일 잠금으로 함께 센다.
"""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
from pathlib import Path

KST = dt.timezone(dt.timedelta(hours=9))
DEFAULT_DAILY_BUDGET = 100
QUOTA_EXCEEDED = 99991403


class BudgetExceeded(RuntimeError):
    pass


def _next_month(day: dt.date) -> dt.date:
    return (day.replace(day=1) + dt.timedelta(days=32)).replace(day=1)


class CallMeter:
    def __init__(self, path: Path, daily_budget: int | None = None, today=lambda: dt.datetime.now(KST).date()):
        self.path = path
        self.daily_budget = daily_budget if daily_budget is not None else int(os.environ.get("FAMIGO_LARK_DAILY_BUDGET", DEFAULT_DAILY_BUDGET))
        self.today = today

    def _update(self, fn):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(fd, "r+", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                raw = f.read()
                state = json.loads(raw) if raw.strip() else {}
            except ValueError:
                state = {}
            result = fn(state)
            f.seek(0)
            f.truncate()
            json.dump(state, f, ensure_ascii=False, indent=2)
            return result

    def state(self) -> dict:
        return self._update(lambda s: dict(s))

    def take(self, what: str = "") -> None:
        """호출 한 번을 쓴다. 막혀 있거나 예산을 넘었으면 BudgetExceeded — 호출하지 말 것."""
        today = self.today().isoformat()

        def apply(s):
            blocked = s.get("blocked_until")
            if blocked and today < blocked:
                raise BudgetExceeded(f"Lark 월 한도 초과로 {blocked} 까지 호출하지 않는다")
            days = s.setdefault("days", {})
            if days.get(today, 0) >= self.daily_budget:
                raise BudgetExceeded(f"오늘 Lark 호출 예산 {self.daily_budget} 을 다 썼다 ({what})")
            days[today] = days.get(today, 0) + 1
            month = today[:7]
            s.setdefault("months", {})[month] = s.get("months", {}).get(month, 0) + 1
            for d in [d for d in days if d < (self.today() - dt.timedelta(days=62)).isoformat()]:
                del days[d]  # 두 달 넘은 일별 기록은 지운다

        self._update(apply)

    def quota_exceeded(self) -> str:
        """Lark 가 월 한도 초과를 알렸다 — 다음 달 1일까지 막는다."""
        until = _next_month(self.today()).isoformat()
        self._update(lambda s: s.update(blocked_until=until, blocked_reason=f"code {QUOTA_EXCEEDED} (월 API 호출 한도 초과)"))
        return until

    def blocked_until(self) -> str | None:
        s = self.state()
        b = s.get("blocked_until")
        return b if b and self.today().isoformat() < b else None
