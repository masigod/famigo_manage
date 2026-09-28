// office.json(빌더 산출물) → DeskRPG 가 읽는 Hermes 플러그인 모양.
// 판단은 하지 않는다 — 빌더가 정한 상태·경과일을 카드 모양으로 옮길 뿐이다.

import { readFileSync, statSync } from "node:fs";

export const KANBAN_TASK_STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
];

const DAY = 86400;

/** 파일 mtime 이 바뀌면 다시 읽는다. 브리핑이 office.json 을 새로 쓰면 재시작 없이 반영된다. */
export function createOfficeSource(path) {
  let cached = null;
  let mtime = -1;
  return function load() {
    const m = statSync(path).mtimeMs;
    if (m !== mtime) {
      const office = JSON.parse(readFileSync(path, "utf8"));
      if (office.schema !== 1) throw new Error(`office.json schema ${office.schema} 미지원`);
      cached = office;
      mtime = m;
    }
    return cached;
  };
}

function epochOf(office) {
  const t = Date.parse(office.generated_at);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

function daysLabel(days) {
  return days === null || days === undefined ? "미확인" : `${days}일`;
}

export function ledgerCard(item, office) {
  const now = epochOf(office);
  const age = item.age_days;
  const lines = [
    `Lark 장부 ${item.id} · 종류 ${item.kind ?? "미기록"} · 원천 상태 ${item.source_status}`,
    `경과 ${daysLabel(age)}${item.stale ? " — 7일 넘게 안 움직였다" : ""}`,
    item.room ? `방: ${item.room}` : null,
    item.due ? `마감: ${item.due}` : null,
    item.assignee ? null : "담당: Lark 장부에 담당자 기록 없음",
  ].filter(Boolean);
  return {
    id: item.id,
    title: `${item.id} · ${item.title}${age !== null && age !== undefined ? ` (${age}일)` : ""}`,
    body: lines.join("\n"),
    status: item.status,
    ...(item.assignee ? { assignee: item.assignee } : {}),
    priority: item.stale ? "high" : "normal",
    ...(item.kind ? { tenant: item.kind } : {}),
    ...(age !== null && age !== undefined ? { created_at: now - age * DAY } : {}),
    comment_count: 0,
    ...(item.stale ? { warnings: { count: 1, highest_severity: "warning" } } : {}),
  };
}

function campaignLines(c) {
  if (!c) return ["캠페인 레지스트리: 연결된 캠페인 없음"];
  return [
    `캠페인: ${c.name}${c.status ? ` · 레지스트리 상태 ${c.status}` : ""}`,
    c.launch || c.end ? `런칭 ${c.launch ?? "미기록"} · 종료 ${c.end ?? "미기록"}` : null,
    c.idle_days !== null && c.idle_days !== undefined ? `캠페인 언급 없음 ${c.idle_days}일` : null,
    c.wbs_count ? `WBS ${c.wbs_count}건 · 마지막 ${c.wbs_last ?? "날짜 미기록"} (원문 줄은 Lark 에서)` : null,
  ].filter(Boolean);
}

export function pipelineCard(item, office) {
  const quiet = item.quiet_days;
  const owner = item.assignee ? office.members.find((m) => m.key === item.assignee)?.display_name ?? item.assignee : null;
  const lines = [
    owner ? `캠페인 담당: ${owner}` : "캠페인 담당: 레지스트리에 기록 없음",
    `방 이름 접두사: ${item.stage}${item.stage_note ? ` (${item.stage_note})` : ""}`,
    `마지막 사람 발화 이후 ${daysLabel(quiet)}`,
    item.zombie ? "⚠ 좀비 후보 — 진행중·준비중인데 21일 이상 조용. 막힌 것인지 죽은 것인지 판정 필요" : null,
    item.external ? "외부 방 — 이름·주제까지만" : null,
    ...campaignLines(item.campaign),
  ].filter(Boolean);
  return {
    id: `C-${item.id}`,
    title: `${item.zombie ? "🔴 " : ""}${item.title} · ${daysLabel(quiet)} 조용`,
    body: lines.join("\n"),
    status: item.status,
    // assignee 를 두지 않는다: DeskRPG 는 재시작 때 running 카드의 assignee 를 '작업 중'으로 되살린다(resync).
    // 캠페인이 진행중이라는 사실이 담당자를 몇 주씩 작업 중으로 만들면 안 된다 — 담당은 본문에 적는다.
    priority: item.zombie ? "high" : "normal",
    tenant: item.stage,
    comment_count: 0,
    ...(item.zombie ? { warnings: { count: 1, highest_severity: "warning" } } : {}),
  };
}

const SECTION_LABEL = {
  doing: "진행 중",
  blocked: "막힘 · 이슈",
  support: "지원 요청",
  action: "우선순위 High",
  next: "다음 할 일",
  today: "한 일",
  presence: "지금 Lark 에서 활동 중",
};

/**
 * 일일보고·실시간 발화에서 온 업무 카드. 사무실 기본 보드에 장부와 함께 올라가, 직원을 누르면 '카드' 탭에 그 사람의 일로
 * 보인다(DeskRPG 는 기본 보드를 assignee 로 걸러 보여 준다). running 카드가 있으면 3D 이름표가 '작업 중'이 된다.
 */
export function workCard(item) {
  const presence = item.section === "presence";
  const created = Date.parse(item.report_ts ? item.report_ts + (/[zZ]|[+-]\d\d:?\d\d$/.test(item.report_ts) ? "" : "+09:00") : "");
  return {
    id: item.id,
    title: presence ? item.title : `${item.title}`,
    body: [
      presence
        ? `Lark 에서 방금 발화가 있었습니다 (${item.report_ts?.replace("T", " ") ?? "시각 미기록"}) — 내용은 옮기지 않습니다.`
        : `${item.author} 님의 일일보고 ${item.report_date} · ${SECTION_LABEL[item.section] ?? item.section}`,
      item.room ? `방: ${item.room}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    status: item.status,
    assignee: item.assignee,
    priority: item.priority,
    tenant: presence ? "지금" : "일일보고",
    ...(Number.isFinite(created) ? { created_at: Math.floor(created / 1000), ...(item.status === "running" ? { started_at: Math.floor(created / 1000) } : {}) } : {}),
    comment_count: 0,
  };
}

export function cardsFor(view, office) {
  if (view === "ledger")
    return office.boards.ledger.map((i) => ledgerCard(i, office)).concat((office.boards.work ?? []).map(workCard));
  if (view === "pipeline") return office.boards.pipeline.map((i) => pipelineCard(i, office));
  return [];
}

export function renderBoard(view, office, includeArchived) {
  const columns = KANBAN_TASK_STATUSES.filter((s) => includeArchived || s !== "archived").map(
    (name) => ({ name, tasks: [] }),
  );
  const tenants = new Set();
  const assignees = new Set();
  for (const card of cardsFor(view, office)) {
    const column = columns.find((c) => c.name === card.status);
    if (!column) continue;
    column.tasks.push(card);
    if (card.tenant) tenants.add(card.tenant);
    if (card.assignee) assignees.add(card.assignee);
  }
  return {
    columns,
    tenants: [...tenants],
    assignees: [...assignees],
    latest_event_id: null,
    now: epochOf(office),
  };
}
