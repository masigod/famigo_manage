// 직원 1:1 대화의 개인화 — 묻는 사람이 누구냐에 따라 답이 다르다(규칙은 gateway/access.mjs).
//
// DeskRPG 는 1:1 대화의 세션 키를 `<npcId>-dm-<userId>` 로 만들어 X-Hermes-Session-Key 로 보낸다
// (socket-handlers.ts). userId 는 DeskRPG 서버가 인증된 소켓에서 넣는다 — 브라우저가 고칠 수 없다.
// 방(`-room-`)·회의 대화는 그 자리의 모두가 보므로 **언제나 공용 답**이다.

import { canSeePerson, isAdmin } from "./access.mjs";

const DM_RE = /-dm-([0-9a-f-]{36})(?:-poll)?$/i;

export function askerOf(sessionKey) {
  const key = String(sessionKey ?? "");
  const dm = DM_RE.exec(key);
  if (dm) return { kind: "dm", userId: dm[1].toLowerCase() };
  return { kind: key.includes("-room-") ? "room" : "unknown" };
}

/** 사무실 직원(office.json member) → 인사이트의 사람 이름. 별칭 중 인사이트에 있는 것. */
export function personOfMember(member, insights) {
  return (member.aliases ?? []).find((a) => insights?.persons?.[a]) ?? null;
}

const bullets = (items, n = 5) => items.slice(0, n).map((i) => `- ${i}`).concat(items.length > n ? [`- … 외 ${items.length - n}건`] : []);

function reportLines(report) {
  if (!report) return ["일일보고 기록이 없습니다 (원문에 [일일보고] 머리가 있는 글만 셉니다)."];
  const out = [`**최근 일일보고 ${report.date}** (${report.room})`];
  const section = (title, items) => (items.length ? ["", `**${title}**`, ...bullets(items)] : []);
  const high = report.actions.high.length ? report.actions.high : [];
  return out.concat(
    section("오늘 한 일", report.today),
    section("진행 중", report.doing),
    section("우선순위 High", high),
    section("다음 할 일", report.next),
    section("막힘 · 이슈", report.blocked),
    section("지원 요청", report.support),
  );
}

function openTodos(person, insights) {
  return (person.todos ?? [])
    .map((id) => insights.todos[id])
    .filter((t) => t && ["todo", "review", "blocked"].includes(t.board_status))
    .sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0));
}

/** 본인·관리자에게 하는 그 사람의 답. */
export function personalMemberReply(member, name, insights, { viewerIsSelf, dashboardUrl }) {
  const p = insights.persons[name];
  const todos = openTodos(p, insights);
  const out = [
    viewerIsSelf ? `${member.display_name}님, 요즘 하신 일을 Lark 에 쓰신 글 기준으로 정리했습니다.` : `${member.display_name} 님의 일입니다 (관리자 보기).`,
    `Lark 발화 ${p.stats.messages}건 · 마지막 ${p.stats.last ?? "기록 없음"} · 일일보고 ${p.daily_reports.length}회`,
    "",
    ...reportLines(p.daily_reports[0]),
  ];
  if (todos.length) out.push("", `**Lark 장부의 열린 항목 ${todos.length}건**`, ...bullets(todos.map((t) => `${t.id} ${t.title} — ${t.age_days ?? "?"}일${t.stale ? " ⚠ 방치" : ""}`)));
  if (p.campaigns.length) out.push("", `**맡은 캠페인** — ${p.campaigns.join(", ")}`);
  if (dashboardUrl) out.push("", `_자세히: ${dashboardUrl}_`);
  return out.join("\n");
}

/** Syn — 관리자에게는 오늘 결정할 것·막힘 전체, 팀원에게는 자기 것과 팀 요약. */
export function personalAnalystReply(who, insights, office, { dashboardUrl }) {
  const out = [];
  if (isAdmin(who)) {
    const d = insights.decisions;
    out.push(d ? `**오늘 결정할 것** (${d.source})` : "오늘 결정할 것: 로컬 브리핑 기록 없음(미확인)");
    if (d) out.push(...bullets(d.items, 8));
    const blocked = Object.values(insights.persons)
      .map((p) => ({ name: p.name, r: p.daily_reports[0] }))
      .filter(({ r }) => r?.blocked?.length);
    out.push("", blocked.length ? `**최신 일일보고의 막힘 ${blocked.length}명**` : "최신 일일보고에 보고된 막힘은 없습니다.");
    out.push(...blocked.slice(0, 8).map(({ name, r }) => `- ${name} (${r.date}): ${r.blocked.slice(0, 2).join(" · ")}`));
  } else {
    const p = insights.persons[who.person];
    out.push(`${who.person}님의 요즘 일입니다.`, "", ...reportLines(p?.daily_reports?.[0]));
  }
  const c = office.counts;
  out.push("", `팀 현황: 열린 장부 ${c.todos_open} · 7일+ 방치 ${c.todos_stale} · 좀비 후보 ${office.hygiene.length}`);
  if (dashboardUrl) out.push("", `_대시보드: ${dashboardUrl}_`);
  return out.join("\n");
}

/**
 * 1:1 대화면 개인화된 답, 아니면 null(→ 공용 답을 쓴다).
 * identity(userId) → {person, role} | null
 */
export function personalReply({ member, sessionKey, insights, office, identity, dashboardUrl }) {
  if (!insights) return null;
  const asker = askerOf(sessionKey);
  if (asker.kind !== "dm") return null;
  const who = identity(asker.userId);
  if (!who) return null;
  if (member.kind === "analyst") return personalAnalystReply(who, insights, office, { dashboardUrl });
  const name = personOfMember(member, insights);
  if (!name || !canSeePerson(who, name)) return null;
  return personalMemberReply(member, name, insights, { viewerIsSelf: who.person === name, dashboardUrl });
}
