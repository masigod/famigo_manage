#!/usr/bin/env python3
"""Lark 변동 → 사무실 실시간 반영 데몬 (launchd: life.famigo.office.live).

왜: 하루 두 번 예약 갱신으로는 Lark 에서 사람이 방에 들어오거나, 방 이름 접두사(캠페인 상태)가
바뀌거나, 브리핑이 장부를 새로 써도 사무실이 몇 시간씩 옛 모습으로 남는다. 변화를 **밀어 받아**
바로 반영한다.

세 갈래로 변화를 듣는다:
  1. Lark 장기 연결(WebSocket) 이벤트 — 공개 URL 없이 이 Mac 에서 나가는 연결 하나.
       im.chat.member.user.added/deleted/withdrawn_v1 · im.chat.member.bot.added/deleted_v1 ·
       im.chat.updated_v1 · im.chat.disbanded_v1           → 명단·방 이름 다시 수집 → 재빌드
       im.message.receive_v1 (그룹 · 사람 발신만)           → 방별 마지막 사람 발화 시각(좀비 판정)
                                                             + 원문(out/live/messages.jsonl) → 개인별 반영
  2. 브리핑 데이터층(briefs/data)·예약 산출물(리포트·대시보드)·관리자 설정 파일의 변경 → 재빌드
  3. 10분마다 전체 대조(reconcile) — 놓친 이벤트·끊긴 연결·날짜 경과(경과일)를 메운다.
     Lark 콘솔에서 이벤트를 아직 켜지 않았어도 이 갈래만으로 10분 이내 반영된다.

경계 (lark-daily-brief §0 승계 · 2026-09-28 Dylan 결정으로 원문 수신):
  - 원문은 예약 루틴과 **같은 규칙**으로 걸러 저장한다 — 자격증명·인증코드 패턴은 메시지째 폐기,
    전화·이메일·주민·계좌는 부분 마스킹(briefs/tools/lark_store.py 의 SECRET_PAT·scrub_pii 그대로).
    그 함수를 못 불러오면 본문을 저장하지 않는다(fail-closed) — 시각만 남긴다.
  - 예약 루틴의 원문 층(briefs/data/raw)에는 쓰지 않는다. 그 층의 주인은 브리핑이다. 여기 쌓은 것은
    07:00 수집 전까지의 보충이고 14일 뒤 지운다(그때는 예약 원문에 있다). 읽을 때 msg_id 로 합친다.
  - 발신자는 명단 수집기와 같은 해시로 이름을 찾는다. open_id 원문은 저장하지 않는다.
  - 1:1(p2p)·봇 발신·봇 방·명단에 없는 방은 본문을 저장하지 않는다.
  - SDK 로그는 INFO 로 고정한다 — SDK 는 DEBUG 에서 이벤트 본문을 찍는다(ws/client.py).
  - 사무실 반영은 scripts/office.sh 를 거친다 — 관리자 웹과 같은 잠금을 쓴다.

이벤트 핸들러는 3초 안에 끝나야 한다(장기 연결 계약). 핸들러는 표시만 하고, 수집·빌드·배치는
작업 스레드가 몰아서(settle) 한다.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

KST = dt.timezone(dt.timedelta(hours=9))
WATCH_DATA_FILES = ("people.json", "rooms.json", "todos.jsonl", "campaigns.json", "lark_daily.jsonl")
ROSTER_EVENTS = (
    "im_chat_member_user_added_v1",
    "im_chat_member_user_deleted_v1",
    "im_chat_member_user_withdrawn_v1",
    "im_chat_member_bot_added_v1",
    "im_chat_member_bot_deleted_v1",
    "im_chat_updated_v1",
    "im_chat_disbanded_v1",
)


def log(msg: str) -> None:
    print(f"[famigo-live {dt.datetime.now(KST).strftime('%F %T')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 순수 판단 (SDK 없이 테스트한다)
# ---------------------------------------------------------------------------


def message_activity(event) -> tuple[str, int] | None:
    """P2ImMessageReceiveV1 → (chat_id, 발신 epoch ms). 그룹방의 사람 발신만. 본문(content)은 보지 않는다."""
    data = getattr(event, "event", None)
    msg = getattr(data, "message", None)
    sender = getattr(data, "sender", None)
    if msg is None or sender is None:
        return None
    if getattr(msg, "chat_type", None) != "group" or getattr(sender, "sender_type", None) != "user":
        return None
    chat_id = getattr(msg, "chat_id", None)
    try:
        ms = int(getattr(msg, "create_time", None))  # SDK 는 문자열 ms 로 준다
    except (TypeError, ValueError):
        return None
    if not isinstance(chat_id, str) or not chat_id or ms <= 0:
        return None
    return chat_id, ms


def _kst_day(ms: int) -> dt.date:
    return dt.datetime.fromtimestamp(ms / 1000, tz=KST).date()


class ActivityStore:
    """방별 마지막 사람 발화 시각. 파일에는 {chat_id: ISO 시각} 만 쓴다(0600)."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._ms: dict[str, int] = {}
        self._dirty = False
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            for chat_id, iso in (raw.get("rooms") or {}).items():
                self._ms[chat_id] = int(dt.datetime.fromisoformat(iso).timestamp() * 1000)
        except (OSError, ValueError, AttributeError, TypeError):
            pass

    def note(self, chat_id: str, ms: int) -> bool:
        """기록한다. 조용한 기간(일 단위)이 바뀌는 경우에만 True — 그때만 재빌드할 가치가 있다."""
        with self._lock:
            prev = self._ms.get(chat_id)
            if prev is not None and ms <= prev:
                return False
            self._ms[chat_id] = ms
            self._dirty = True
            return prev is None or _kst_day(ms) > _kst_day(prev)

    def flush(self) -> bool:
        with self._lock:
            if not self._dirty:
                return False
            rooms = {
                k: dt.datetime.fromtimestamp(v / 1000, tz=KST).isoformat(timespec="seconds")
                for k, v in sorted(self._ms.items())
            }
            self._dirty = False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"schema": 1, "rooms": rooms}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)
        return True


class Pending:
    """변화 표시를 모아 한 번에 처리한다. 마지막 표시 뒤 settle 초 조용하면, 또는 첫 표시 뒤 max_wait 초가
    지나면 처리할 때다 — 이벤트가 몰려도 재빌드는 max_wait 에 한 번을 넘지 않는다."""

    def __init__(self, settle: float = 3.0, max_wait: float = 20.0, clock=time.monotonic):
        self.settle, self.max_wait, self.clock = settle, max_wait, clock
        self._lock = threading.Lock()
        self._reasons: set[str] = set()
        self._roster = False
        self._chats: set[str] = set()
        self._drop: set[str] = set()
        self._first = self._last = None

    def mark(self, reason: str, roster: bool = False, chats=(), drop=()) -> None:
        """roster: 전체 명단 수집(주 1회). chats: 이벤트가 가리킨 방만 다시 읽는다. drop: 해산된 방(호출 없음)."""
        with self._lock:
            now = self.clock()
            self._reasons.add(reason)
            self._roster = self._roster or roster
            self._chats |= {c for c in chats if c}
            self._drop |= {c for c in drop if c}
            self._first = self._first if self._first is not None else now
            self._last = now

    def take(self) -> tuple[set[str], bool, set[str], set[str]] | None:
        with self._lock:
            if self._first is None:
                return None
            now = self.clock()
            if now - self._last < self.settle and now - self._first < self.max_wait:
                return None
            out = (self._reasons, self._roster, self._chats - self._drop, self._drop)
            self._reasons, self._roster, self._chats, self._drop, self._first, self._last = set(), False, set(), set(), None, None
            return out


def file_marks(paths: list[Path]) -> dict[str, tuple[int, int] | None]:
    marks = {}
    for p in paths:
        try:
            st = p.stat()
            marks[str(p)] = (st.st_mtime_ns, st.st_size)
        except OSError:
            marks[str(p)] = None
    return marks


LIVE_KEEP_DAYS = 14


def load_brief_filters(tools_dir: Path):
    """예약 루틴의 거름망을 그대로 쓴다: (본문 추출, 비밀 패턴, PII 마스킹, 봇 방 판정). 없으면 None."""
    try:
        sys.path.insert(0, str(tools_dir))
        import lark_api  # noqa: WPS433 — 모듈 수준 부작용 없음(상수·함수만)
        import lark_store

        return lark_api._text_of, lark_store.SECRET_PAT, lark_store.scrub_pii, lark_store.is_bot
    except Exception as e:
        log(f"예약 루틴 거름망을 못 불러옴 — 원문은 저장하지 않고 시각만 남긴다: {type(e).__name__}")
        return None


class Directory:
    """명단 수집기 산출물로 발신자·방을 푼다. open_id 는 수집기와 같은 해시(앞 16자)로만 비교한다."""

    def __init__(self, roster_path: Path):
        self.path, self._mtime, self.names, self.rooms = roster_path, None, {}, {}

    def refresh(self) -> None:
        try:
            m = self.path.stat().st_mtime_ns
        except OSError:
            return
        if m == self._mtime:
            return
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.names = {p["id"]: p["name"] for p in raw.get("members", []) if p.get("id")}
        self.rooms = {r["chat_id"]: r for r in raw.get("rooms", []) if r.get("chat_id")}
        self._mtime = m

    def author(self, open_id: str | None) -> str:
        if not open_id:
            return "?"
        self.refresh()
        return self.names.get(hashlib.sha256(open_id.encode()).hexdigest()[:16]) or f"user:{open_id[-6:]}"

    def room(self, chat_id: str) -> dict | None:
        self.refresh()
        return self.rooms.get(chat_id)


def message_row(
    *, chat_id, msg_type, content, message_id, thread_id, create_ms, open_id, directory: Directory, filters
) -> dict | None:
    """Lark 메시지 하나 → 예약 원문과 같은 모양의 한 행. 이벤트와 폴링이 같이 쓴다. 저장하면 안 되면 None.
    거름망(예약 루틴의 _text_of·SECRET_PAT·scrub_pii·is_bot)이 없으면 저장하지 않는다(fail-closed)."""
    if filters is None:
        return None
    text_of, secret_pat, scrub_pii, is_bot = filters
    room = directory.room(chat_id or "")
    if not room or room.get("external") or is_bot(room.get("name") or ""):
        return None  # 모르는 방은 봇 방인지 판정할 수 없다 — 저장하지 않는다
    try:
        ms = int(create_ms)
    except (TypeError, ValueError):
        return None
    if not message_id:
        return None
    when = dt.datetime.fromtimestamp(ms / 1000, tz=KST)
    text = text_of({"msg_type": msg_type or "", "body": {"content": content or "{}"}})
    row = {
        "ts": when.replace(tzinfo=None).isoformat(timespec="seconds"),  # 예약 원문과 같은 KST 로컬 표기
        "date": when.date().isoformat(),
        "author": directory.author(open_id),
        "text": text,
        "msg_id": message_id,
        "msg_type": msg_type,
        "thread_id": thread_id or None,
        "room": room["name"],
        "kind": "group",
        "live": True,
    }
    if secret_pat.search(text or ""):
        row.update(text="[REDACTED — 자격증명·인증코드 패턴 감지]", redacted=True)
    else:
        scrubbed, n = scrub_pii(text)
        if n:
            row.update(text=scrubbed, pii_masked=n)
    return row


def live_record(event, directory: Directory, filters) -> dict | None:
    """P2ImMessageReceiveV1 → 한 행. 그룹방의 사람 발신만."""
    data = getattr(event, "event", None)
    msg, sender = getattr(data, "message", None), getattr(data, "sender", None)
    if msg is None or getattr(msg, "chat_type", None) != "group" or getattr(sender, "sender_type", None) != "user":
        return None
    return message_row(
        chat_id=getattr(msg, "chat_id", None),
        msg_type=getattr(msg, "message_type", None),
        content=getattr(msg, "content", None),
        message_id=getattr(msg, "message_id", None),
        thread_id=getattr(msg, "thread_id", None),
        create_ms=getattr(msg, "create_time", None),
        open_id=getattr(getattr(sender, "sender_id", None), "open_id", None),
        directory=directory,
        filters=filters,
    )


class LiveMessages:
    """out/live/messages.jsonl — 0600 파일, 0700 폴더. msg_id 로 중복을 거른다(재전송 이벤트 대비)."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._seen = {r.get("msg_id") for r in self._rows()}

    def _rows(self) -> list[dict]:
        if not self.path.exists():
            return []
        rows = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        return rows

    def add(self, row: dict) -> bool:
        with self._lock:
            if row["msg_id"] in self._seen:
                return False
            self.path.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(self.path.parent, 0o700)
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
            self._seen.add(row["msg_id"])
            return True

    def compact(self, today: dt.date, keep_days: int = LIVE_KEEP_DAYS) -> int:
        """keep_days 보다 오래된 행을 지운다 — 그때는 예약 원문(정본)에 들어가 있다."""
        with self._lock:
            rows = self._rows()
            cutoff = (today - dt.timedelta(days=keep_days)).isoformat()
            kept = [r for r in rows if (r.get("date") or "") >= cutoff]
            if len(kept) == len(rows):
                return 0
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_TRUNC | os.O_CREAT, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in kept)
            tmp.replace(self.path)
            self._seen = {r.get("msg_id") for r in kept}
            return len(rows) - len(kept)


def watch_paths(data_dir: Path, root: Path) -> list[Path]:
    """예약 루틴이 쓰는 것 전부 — 데이터층, 원문 인덱스, 브리핑·리포트 폴더(파일이 생기면 폴더 mtime 이 바뀐다),
    대시보드 HTML — 과 관리자 설정."""
    briefs = data_dir.parent
    reports = briefs / "reports"
    weeks = sorted(p for p in reports.glob("20*") if p.is_dir())[-1:] if reports.is_dir() else []
    return (
        [data_dir / f for f in WATCH_DATA_FILES]
        + [data_dir / "index.json", briefs, reports, reports / "_monthly", reports / "_analysis", *weeks]
        + [briefs / "dashboard" / "lark_dashboard.html", briefs / "dashboard" / "lark_dashboard_share.html"]
        + [root / "config" / "office.config.json"]
    )


def member_signature(office: dict) -> str:
    """시더가 DeskRPG 에 옮기는 것(직원 키·표시 이름·외형·퇴장·사무실)만의 지문. 보드·경과일은 게이트웨이가
    office.json 에서 바로 서빙하므로 이것이 안 바뀌면 시더를 돌릴 필요가 없다."""
    basis = {
        "org": office.get("org"),
        "members": sorted(
            (m.get("key"), m.get("display_name"), m.get("look"), m.get("kind")) for m in office.get("members", [])
        ),
        "excluded_keys": sorted(office.get("excluded_keys", [])),
    }
    return hashlib.sha256(json.dumps(basis, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


# ---------------------------------------------------------------------------
# 실행
# ---------------------------------------------------------------------------


class Runner:
    def __init__(self, root: Path, run=subprocess.run):
        self.root, self.run = root, run
        self.last_signature: str | None = None  # 시작 직후 첫 주기는 반드시 배치한다

    def office(self, cmd: str, *extra: str) -> int:
        r = self.run(
            ["bash", str(self.root / "scripts" / "office.sh"), cmd, *extra],
            cwd=self.root, capture_output=True, text=True, env=os.environ.copy(),
        )
        lines = [l for l in (r.stdout + r.stderr).splitlines() if l.strip()]
        if r.returncode == 0:  # 성공이면 요약 줄과 사무실 변화만
            lines = [l for l in lines if l.startswith(("✓", "⚠", "직원", "퇴장", "사무실", "프로젝트"))]
        for l in lines:
            log(f"  {cmd}: {l}")
        return r.returncode

    def cycle(self, roster: bool, chats=(), drop=()) -> bool:
        """한 번 반영한다. 사무실까지 다 반영됐으면 True — False 면 작업 스레드가 곧 다시 시도한다.
        roster: 전체 명단(주 1회 · 약 75호출). chats/drop: 이벤트가 가리킨 방만(방마다 2~3호출 · 해산은 0)."""
        if roster and self.office("roster") != 0:
            log("  명단 수집 실패 — 직전 명단으로 계속")
        elif chats or drop:
            extra = [*(["--chats", ",".join(sorted(chats))] if chats else []), *(["--drop", ",".join(sorted(drop))] if drop else [])]
            if self.office("roster", *extra) != 0:
                log("  방 갱신 실패 — 직전 명단으로 계속 (다음 주 전체 수집 때 맞춰진다)")
        if self.office("build") != 0:
            return False
        try:
            office = json.loads((self.root / "out" / "office.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            log(f"  office.json 을 못 읽음: {type(e).__name__}")
            return False
        signature = member_signature(office)
        if signature == self.last_signature:
            return True
        if self.office("seed") != 0:
            return False  # DeskRPG 가 아직 안 떴거나 일시 오류 — 지문을 남기지 않아 다음에 다시 배치한다
        self.last_signature = signature
        return True


RETRY_SECONDS = 30.0
FULL_ROSTER_DAYS = 7  # 전체 명단(방 수만큼 호출)은 이보다 오래됐을 때만 — 평소엔 이벤트가 가리킨 방만


def roster_is_stale(root: Path, now: dt.datetime | None = None) -> bool:
    try:
        raw = json.loads((root / "out" / "lark_roster.json").read_text(encoding="utf-8"))
        full = dt.datetime.fromisoformat(raw.get("full_at") or raw.get("generated_at"))
    except (OSError, ValueError, TypeError):
        return True
    return ((now or dt.datetime.now(KST)) - full).days >= FULL_ROSTER_DAYS
# '지금 Lark'(30분)·'진행 중'(36시간) 카드는 시간이 지나면 꺼져야 한다 — 새 이벤트가 없어도 이 주기로 다시 짓는다.
# 빌드만 돈다(0.5초 안팎) — 직원이 그대로면 시더는 돌지 않는다.
CLOCK_SECONDS = 300.0


def worker(
    pending: Pending,
    store: ActivityStore,
    runner: Runner,
    reconcile: float,
    stop: threading.Event,
    live: "LiveMessages | None" = None,
) -> None:
    last_reconcile = last_clock = time.monotonic()
    retry_at = None
    while not stop.is_set():
        now = time.monotonic()
        if now - last_clock >= CLOCK_SECONDS:
            pending.mark("시각")
            last_clock = now
        if now - last_reconcile >= reconcile:
            # 대조는 Lark API 를 부르지 않는다(빌드만) — 월 호출 한도(2026-09-28 사고). 전체 명단은 주 1회.
            pending.mark("대조", roster=roster_is_stale(runner.root))
            last_reconcile = now
            if live is not None:
                dropped = live.compact(dt.datetime.now(KST).date())
                if dropped:
                    log(f"실시간 원문 {dropped}건 정리 ({LIVE_KEEP_DAYS}일 경과 — 예약 원문에 있다)")
        if retry_at is not None and now >= retry_at:
            pending.mark("재시도")
            retry_at = None
        job = pending.take()
        if job:
            reasons, roster, chats, drop = job
            store.flush()
            started = time.monotonic()
            log(f"반영 시작 ({', '.join(sorted(reasons))}{' · 전체 명단 수집' if roster else ''}{f' · 방 {len(chats) + len(drop)}곳 갱신' if chats or drop else ''})")
            try:
                ok = runner.cycle(roster, chats, drop)
            except Exception as e:  # 작업 스레드는 죽지 않는다
                log(f"  반영 실패: {type(e).__name__}: {e}")
                ok = False
            log(f"반영 {'끝' if ok else f'미완 — {int(RETRY_SECONDS)}초 뒤 재시도'} ({time.monotonic() - started:.1f}s)")
            if not ok:
                retry_at = time.monotonic() + RETRY_SECONDS
            if roster:
                last_reconcile = time.monotonic()
        stop.wait(0.5)


def watcher(paths, pending: Pending, stop: threading.Event, interval: float = 2.0) -> None:
    """paths: 경로 목록 또는 그것을 돌려주는 함수(주가 바뀌면 이번 주 리포트 폴더가 바뀐다)."""
    current = paths if callable(paths) else (lambda: paths)
    before = file_marks(current())
    while not stop.wait(interval):
        now = file_marks(current())
        changed = [Path(p).name for p in now if now[p] != before.get(p)]
        if changed:
            pending.mark("파일:" + ",".join(sorted(changed)))
        before = now


URL_QUERY_RE = re.compile(r"(wss?://[^\s?\]]+)\?[^\s\]]*")


class RedactUrlQuery(logging.Filter):
    """SDK 는 INFO 에서 장기 연결 URL 을 통째로 찍는다 — 쿼리에 access_key·ticket 이 들어 있다
    (2026-09-28 실측). 연결·끊김 줄은 남기되 쿼리는 가린다."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = URL_QUERY_RE.sub(r"\1?<가림>", message)
        if redacted != message:
            record.msg, record.args = redacted, ()
        return True


def guarded(name: str, fn):
    """SDK 이벤트 핸들러 — 예외가 나도 본문이 로그로 새지 않게 형식 이름만 남긴다."""

    def handler(data):
        try:
            fn(data)
        except Exception as e:
            log(f"이벤트 처리 실패 {name}: {type(e).__name__}")

    return handler


def meter_ws_endpoint(client, meter) -> None:
    """SDK 의 장기 연결 주소 조회(연결·재연결마다 HTTP 1회)도 계량기를 지나게 한다.
    SDK 는 HTTP 단계에서 거절되면 120초마다 끝없이 다시 시도한다(ws/client.py _reconnect) — 월 한도가 막혔을 때
    하루 720회를 헛쓰지 않도록, 막혔거나 예산을 넘었으면 ClientException 으로 재시도 고리를 끊는다."""
    from lark_meter import QUOTA_EXCEEDED
    from lark_oapi.ws.exception import ClientException

    original = client._get_conn_url

    def guarded():
        try:
            meter.take("ws endpoint")
        except Exception as e:
            raise ClientException(-1, f"Lark 호출 계량기: {e}") from e
        try:
            return original()
        except Exception as e:
            if "quota" in str(e).lower() or str(QUOTA_EXCEEDED) in str(e):
                meter.quota_exceeded()
                raise ClientException(QUOTA_EXCEEDED, "월 API 호출 한도 초과 — 다음 달까지 연결하지 않는다") from e
            raise

    client._get_conn_url = guarded


def start_events(
    root: Path,
    credentials: Path,
    pending: Pending,
    store: ActivityStore,
    directory: "Directory | None" = None,
    live: "LiveMessages | None" = None,
    filters=None,
) -> None:
    """Lark 장기 연결. 블로킹이다 — SDK 가 모듈 전역 이벤트 루프를 쓰므로 메인 스레드에서 돈다."""
    import lark_oapi as lark  # venv(~/.famigo-office/venv)에만 있다
    from lark_meter import CallMeter

    logging.getLogger("Lark").addFilter(RedactUrlQuery())
    sys.path.insert(0, str(root / "office"))
    from lark_roster import load_credentials

    app_id, secret, domain = load_credentials(credentials)
    builder = lark.EventDispatcherHandler.builder("", "")
    def chat_of(data) -> str | None:
        return getattr(getattr(data, "event", None), "chat_id", None)

    for name in ROSTER_EVENTS:
        register = getattr(builder, f"register_p2_{name}")
        if name == "im_chat_disbanded_v1":
            handler = lambda d, n=name: pending.mark(n, drop=[chat_of(d)])  # noqa: E731 — 해산: 호출 없이 뺀다
        else:
            handler = lambda d, n=name: pending.mark(n, chats=[chat_of(d)])  # noqa: E731 — 그 방만 다시 읽는다
        builder = register(guarded(name, handler))

    def on_message(data):
        hit = message_activity(data)
        if hit and store.note(*hit):
            pending.mark("발화")
        row = live_record(data, directory, filters) if directory is not None and live is not None else None
        if row and live.add(row):
            pending.mark("메시지")  # 개인별 화면(자기가 쓴 글)을 곧 갱신한다

    builder = builder.register_p2_im_message_receive_v1(guarded("im_message_receive_v1", on_message))
    client = lark.ws.Client(app_id, secret, event_handler=builder.build(), domain=domain, log_level=lark.LogLevel.INFO)
    meter_ws_endpoint(client, CallMeter(root / "out" / "lark_calls.json"))
    log(f"Lark 장기 연결 시작 ({domain})")
    client.start()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--data-dir", type=Path, default=Path("~/famigo_campaign/briefs/data").expanduser())
    ap.add_argument("--credentials", type=Path, default=Path("~/.config/famigo/lark_credentials.json").expanduser())
    ap.add_argument("--reconcile", type=float, default=600.0, help="전체 대조 주기(초)")
    ap.add_argument("--no-events", action="store_true", help="장기 연결 없이 파일 감시 + 주기 대조만")
    args = ap.parse_args(argv)
    # FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다 — Lark 와 이 Mac 말고는 이름 풀이부터 막는다(office/egress.py).
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import egress

    egress.install()

    root = args.root.resolve()
    data_dir = args.data_dir.expanduser()
    pending = Pending()
    store = ActivityStore(root / "out" / "lark_activity.json")
    live = LiveMessages(root / "out" / "live" / "messages.jsonl")
    directory = Directory(root / "out" / "lark_roster.json")
    filters = load_brief_filters(data_dir.parent / "tools")
    runner = Runner(root)
    stop = threading.Event()

    pending.mark("시작", roster=roster_is_stale(root))
    threading.Thread(target=worker, args=(pending, store, runner, args.reconcile, stop, live), daemon=True).start()
    threading.Thread(target=watcher, args=(lambda: watch_paths(data_dir, root), pending, stop), daemon=True).start()
    log(
        f"감시: 데이터층·예약 산출물·관리자 설정 · 전체 대조 {int(args.reconcile)}초마다 · "
        f"원문 수신 {'켜짐' if filters else '꺼짐(거름망 없음)'}"
    )

    if not args.no_events:
        sys.path.insert(0, str(root / "office"))
        from lark_meter import CallMeter

        meter = CallMeter(root / "out" / "lark_calls.json")
        # 월 한도 초과면 장기 연결도 시도하지 않는다 — 연결할 때마다 엔드포인트 조회 호출이 하나 든다.
        while (until := meter.blocked_until()) and not stop.is_set():
            log(f"Lark 월 호출 한도 초과 — {until} 까지 장기 연결을 미룬다 (파일 감시·대조는 계속)")
            stop.wait(3600)
        try:
            start_events(root, args.credentials.expanduser(), pending, store, directory, live, filters)
        except Exception as e:  # 연결을 못 열어도 파일 감시·주기 대조는 계속한다
            log(f"Lark 장기 연결 불가 — 파일 감시와 {int(args.reconcile)}초 대조로만 반영: {type(e).__name__}: {e}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
