// office.json 이 바뀔 때마다 이전 판과 비교해 카드 변화를 Hermes 플러그인 이벤트(`/deskrpg/events`)로 낸다.
//
// 왜: DeskRPG 는 이 이벤트를 5~60초마다 폴링해서 (a) 열린 칸반에 `kanban:event` 로 방송하고,
// (c) review·blocked·done 으로 넘어간 카드를 사무실 채팅에 공지한다(automation-events.ts). 이벤트가 비어
// 있으면 Lark 에서 장부 항목이 해결돼도 보드를 다시 열기 전까지 화면이 옛 모습이다.
//
// 계약 (deskrpg src/lib/hermes/deskrpg-plugin-types.ts · fake-plugin-server.ts):
//   - 커서 없는 호출은 '지금' 토큰만 준다 — 과거를 재생하지 않는다(R23).
//   - PluginEvent = { id, ts(epoch 초), kind, board, task_id, payload }
//   - task.status  { from, to, parent_count, title, assignee }
//   - task.created { title, status, assignee } · task.deleted { title } · task.updated { title, assignee, fields }
//
// 경과일은 매일 바뀌므로 비교에 넣지 않는다 — 넣으면 자정마다 카드 전부가 '변경'으로 쏟아진다.
// 이벤트 기록과 직전 스냅숏은 파일에 남겨 게이트웨이를 재시작해도 커서가 이어진다.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const MAX_EVENTS = 1000;

/** 뷰별 카드 지문 — 카드 id 는 office-model.mjs 의 카드 id 와 같다. */
export function snapshotOf(office) {
  const ledger = {};
  for (const t of office.boards.ledger)
    ledger[t.id] = { status: t.status, title: t.title, assignee: t.assignee ?? null, flag: Boolean(t.stale) };
  // 업무 카드(일일보고·지금 Lark)도 기본 보드(장부 뷰)에 있다 — 같은 뷰로 비교한다.
  for (const w of office.boards.work ?? [])
    ledger[w.id] = { status: w.status, title: w.title, assignee: w.assignee ?? null, flag: false };
  const pipeline = {};
  for (const p of office.boards.pipeline)
    pipeline[`C-${p.id}`] = {
      status: p.status,
      title: p.title,
      assignee: p.assignee ?? null,
      flag: Boolean(p.zombie),
      stage: p.stage ?? null,
    };
  return { ledger, pipeline };
}

const runStarted = (view, id, card) => ({ view, kind: "task.run.started", task_id: id, payload: { assignee: card.assignee, title: card.title } });

/** 두 스냅숏의 차이 → [{ view, kind, task_id, payload }] (순수 함수). */
export function diffSnapshots(prev, next) {
  const out = [];
  for (const view of ["ledger", "pipeline"]) {
    const a = prev?.[view] ?? {};
    const b = next?.[view] ?? {};
    for (const [id, card] of Object.entries(b)) {
      const old = a[id];
      if (!old) {
        out.push({ view, kind: "task.created", task_id: id, payload: { title: card.title, status: card.status, assignee: card.assignee } });
        // 막힘·지원 요청은 새로 생겨도 사무실 채팅에 알린다(DeskRPG 는 task.status 로만 공지한다).
        if (card.status === "blocked" || card.status === "review")
          out.push({ view, kind: "task.status", task_id: id, payload: { from: null, to: card.status, parent_count: 0, title: card.title, assignee: card.assignee } });
        if (card.status === "running" && view === "ledger") out.push(runStarted(view, id, card));
        continue;
      }
      if (old.status !== card.status) {
        out.push({
          view,
          kind: "task.status",
          task_id: id,
          payload: { from: old.status, to: card.status, parent_count: 0, title: card.title, assignee: card.assignee },
        });
        // '작업 중' 3D 표시는 run 이벤트로만 켜진다(automation-events.ts updateWorking). 꺼짐은 task.status 가 한다.
        // 기본 보드(장부 뷰)만 — 캠페인이 '진행중'이라고 담당자가 몇 주씩 작업 중으로 보이면 신호가 죽는다.
        if (card.status === "running" && view === "ledger") out.push(runStarted(view, id, card));
        continue;
      }
      const fields = Object.keys(card).filter((k) => old[k] !== card[k]);
      if (fields.length)
        out.push({ view, kind: "task.updated", task_id: id, payload: { title: card.title, assignee: card.assignee, fields } });
    }
    for (const [id, card] of Object.entries(a))
      if (!(id in b)) out.push({ view, kind: "task.deleted", task_id: id, payload: { title: card.title } });
  }
  return out;
}

/**
 * 이벤트 기록. cursor 는 전역 일련번호(문자열)다. 보드마다 뷰가 다르므로 poll 때 보드의 뷰로 거르고,
 * 커서는 '훑은 곳까지'로 올린다 — 다른 보드의 이벤트 때문에 커서가 멈추지 않는다.
 */
export function createEventLog(path, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  let state = { seq: 0, snapshot: null, events: [] };
  if (path && existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (Number.isInteger(saved.seq) && Array.isArray(saved.events)) state = saved;
    } catch {
      // 깨진 기록은 버린다 — 다음 office.json 이 새 기준선이 된다(재생 없음).
    }
  }
  const save = () => {
    if (!path) return;
    writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };

  return {
    get seq() {
      return state.seq;
    },
    /** 새 office.json 을 본다. 첫 판은 기준선일 뿐 이벤트를 내지 않는다. 낸 이벤트 수를 돌려준다. */
    observe(office) {
      const next = snapshotOf(office);
      const changes = state.snapshot ? diffSnapshots(state.snapshot, next) : [];
      const ts = now();
      for (const c of changes) {
        state.seq += 1;
        state.events.push({ seq: state.seq, ts, ...c });
      }
      if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
      state.snapshot = next;
      save();
      return changes.length;
    },
    /** GET /deskrpg/events — view 가 null 이면 모든 뷰. */
    poll({ board, view, cursor, limit = 200 }) {
      if (cursor === null || cursor === undefined || cursor === "")
        return { events: [], cursor: String(state.seq), has_more: false };
      let from = Number(cursor);
      // 모르는 커서(기록이 새로 시작됐거나 형식이 다름)는 '지금'으로 — 재생하지 않는다.
      if (!Number.isInteger(from) || from < 0 || from > state.seq) from = state.seq;
      const page = [];
      let scanned = from;
      let hasMore = false;
      for (const e of state.events) {
        if (e.seq <= from) continue;
        if (view && e.view !== view) {
          scanned = e.seq;
          continue;
        }
        if (page.length === limit) {
          hasMore = true;
          break;
        }
        page.push({
          id: `famigo-${e.seq}`,
          ts: e.ts,
          kind: e.kind,
          ...(board ? { board } : {}),
          task_id: e.task_id,
          payload: e.payload,
        });
        scanned = e.seq;
      }
      // 다 훑었으면 커서는 끝(seq)까지, 페이지가 찼으면 마지막으로 넘긴 이벤트까지.
      return { events: page, cursor: String(hasMore ? scanned : state.seq), has_more: hasMore };
    },
  };
}
