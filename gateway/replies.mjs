// 사무실 대화에서 직원이 하는 말. LLM 없이 office.json 의 사실만 말한다.
// 없는 것은 "없다"가 아니라 "기록 없음/미확인"으로 말한다 (검증된 0 ≠ 미확인).

const OPEN = new Set(["todo", "review", "blocked"]);

function ageOf(item) {
  return item.age_days ?? -1;
}

function line(item) {
  const age = item.age_days === null || item.age_days === undefined ? "경과 미확인" : `${item.age_days}일째`;
  return `- ${item.id} ${item.title} — ${age}`;
}

/** 방 대화 입력에서 마지막 발화만 뽑는다 (DeskRPG 가 최근 대화를 블록으로 넣어 보낸다). */
export function lastUtterance(input) {
  const block = /\[(?:최근 대화|Recent conversation)\]\n([\s\S]*?)\n\[(?:답하는 법|How to reply)\]/.exec(
    input,
  );
  const text = block ? block[1].trim().split("\n").at(-1) : input;
  return String(text ?? "").slice(-500);
}

function memberReply(member, office) {
  const mine = office.boards.ledger
    .filter((t) => t.assignee === member.key && OPEN.has(t.status))
    .sort((a, b) => ageOf(b) - ageOf(a));
  const campaigns = office.boards.pipeline.filter(
    (c) => c.assignee === member.key && !["done", "archived"].includes(c.status),
  );
  const who = [member.role, member.team].filter(Boolean).join(" · ");
  const out = [`${member.display_name}${who ? ` (${who})` : ""}입니다.`];
  if (mine.length) {
    out.push("", `**Lark 장부에서 제 이름이 걸린 열린 항목 ${mine.length}건**`, "");
    out.push(...mine.slice(0, 5).map(line));
  } else {
    out.push("Lark 장부에 제 이름이 담당으로 기록된 열린 항목은 없습니다. (담당 칸이 빈 항목은 세지 않았습니다)");
  }
  if (campaigns.length) {
    out.push("", `**맡은 캠페인 ${campaigns.length}건** — ${campaigns.map((c) => `${c.title}(${c.stage})`).join(", ")}`);
  }
  const rooms = member.rooms ?? [];
  if (rooms.length) {
    const shown = rooms.slice(0, 8).join(", ");
    out.push("", `**참여 중인 Lark 방 ${rooms.length}개** — ${shown}${rooms.length > 8 ? ` 외 ${rooms.length - 8}` : ""}`);
  }
  out.push("", `_기준 ${office.generated_at} Lark 브리핑 데이터_`);
  return out.join("\n");
}

function decisions(office) {
  const review = office.boards.ledger.filter((t) => t.status === "review").sort((a, b) => ageOf(b) - ageOf(a));
  const stale = office.boards.ledger
    .filter((t) => t.stale && t.status !== "review")
    .sort((a, b) => ageOf(b) - ageOf(a));
  const out = [];
  if (review.length) out.push("", `**결정 대기 ${review.length}건**`, "", ...review.slice(0, 5).map(line));
  else out.push("", "결정 대기로 분류된 항목은 없습니다.");
  if (stale.length) out.push("", `**7일+ 방치 ${stale.length}건** (오래된 순)`, "", ...stale.slice(0, 5).map(line));
  return out;
}

function pipeline(office) {
  const byStage = {};
  for (const c of office.boards.pipeline) byStage[c.stage] = (byStage[c.stage] ?? 0) + 1;
  const stages = Object.entries(byStage)
    .map(([s, n]) => `${s} ${n}`)
    .join(" · ");
  return [
    "",
    `**파이프라인**(방 이름 접두사 기준): ${stages || "접두사 있는 방 없음"} · 접두사 없음 ${office.counts.rooms_without_stage}`,
    ...hygiene(office),
  ];
}

function hygiene(office) {
  if (!office.hygiene.length) return ["", "좀비 후보 없음 (진행중·준비중 중 21일+ 조용한 방)."];
  return [
    "",
    `**좀비 후보 ${office.hygiene.length}건**`,
    "",
    ...office.hygiene.slice(0, 7).map((h) => `- ${h.room} (${h.stage}) — ${h.quiet_days}일 조용`),
  ];
}

function header(office) {
  const d = office.daily;
  if (!d) return `기준 ${office.generated_at} · 일일 수집 기록 없음(미확인)`;
  const swept = d.rooms_swept ?? "미확인";
  const failed = d.rooms_failed ?? "미확인";
  return `기준 ${office.generated_at} · 최근 수집 ${d.date ?? "날짜 미기록"} · 방 ${swept} · 실패 ${failed}`;
}

function analystReply(text, office) {
  const q = text.toLowerCase();
  const out = [header(office)];
  if (/파이프라인|캠페인|pipeline|campaign/.test(q)) out.push(...pipeline(office));
  else if (/위생|좀비|zombie|hygiene/.test(q)) out.push(...hygiene(office));
  else out.push(...decisions(office));
  out.push(
    "",
    `_※ Lark ${office.daily?.rooms_swept ?? office.counts.rooms}방 밖(구두·전화·메일·외부 그룹)은 이 데이터에 없습니다. '없음'이 아니라 '이 창에 없음'입니다._`,
  );
  return out.join("\n");
}

export function composeReply(profile, input, office, { meeting = false } = {}) {
  const member = office.members.find((m) => m.key === profile);
  if (!member) return "이 프로필은 오피스 모델에 없습니다.";
  const text = lastUtterance(input);
  const reply = member.kind === "analyst" ? analystReply(text, office) : memberReply(member, office);
  // 회의 모드는 한 줄 발언 형식(SPEAK:)을 기대한다.
  return meeting
    ? `SPEAK: ${reply
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 3)
        .join(" ")
        .replace(/\*\*|_/g, "")}`
    : reply;
}
