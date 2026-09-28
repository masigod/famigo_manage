// 대시보드 화면 — 한 파일, 외부 리소스 0. 원문(Lark 메시지·리포트)은 전부 textContent 로만 그린다.
// 팔레트는 예약 루틴 대시보드의 계보(올빼미: #141b2e / #c9d1e0 / #e8a33d)를 잇는다 — 둘이 한 집안으로 보이게.

export function renderDashboardPage() {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Famigo Office 대시보드</title>
<style>
:root { --bg:#141b2e; --panel:#1b2440; --line:#2a3558; --ink:#c9d1e0; --dim:#8a94ad; --accent:#e8a33d; --bad:#e0685c; --ok:#6cc08b; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 -apple-system, "Apple SD Gothic Neo", "Pretendard", sans-serif; }
header { display:flex; gap:16px; align-items:center; padding:14px 22px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
header h1 { font-size:16px; margin:0; color:#fff; }
header .who { margin-left:auto; color:var(--dim); font-size:13px; }
nav { display:flex; gap:4px; padding:10px 22px 0; flex-wrap:wrap; border-bottom:1px solid var(--line); }
nav button { background:none; border:0; color:var(--dim); padding:8px 12px; border-bottom:2px solid transparent; cursor:pointer; font:inherit; }
nav button[aria-selected=true] { color:#fff; border-color:var(--accent); }
nav button:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
main { padding:20px 22px 60px; max-width:1280px; margin:0 auto; }
h2 { font-size:15px; color:#fff; margin:22px 0 10px; }
h3 { font-size:13px; color:var(--accent); margin:14px 0 6px; font-weight:600; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:14px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.muted { color:var(--dim); }
.tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); color:var(--dim); margin-right:6px; }
.tag.bad { color:var(--bad); border-color:var(--bad); } .tag.warn { color:var(--accent); border-color:var(--accent); } .tag.ok { color:var(--ok); border-color:var(--ok); }
ul { margin:4px 0 8px; padding-left:18px; } li { margin:2px 0; }
table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--dim); font-weight:500; font-size:12px; }
tr.click { cursor:pointer; } tr.click:hover { background:#202b4d; }
.msg { border-bottom:1px solid var(--line); padding:8px 0; }
.msg .meta { font-size:12px; color:var(--dim); }
.msg .text { white-space:pre-wrap; word-break:break-word; }
.stats { display:flex; gap:22px; flex-wrap:wrap; } .stat b { display:block; font-size:22px; color:#fff; }
.bar { display:flex; align-items:flex-end; gap:3px; height:60px; } .bar span { flex:1; background:var(--accent); opacity:.75; min-height:2px; border-radius:2px 2px 0 0; }
input[type=search], select { background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0; }
button.more { background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
iframe { width:100%; height:78vh; border:1px solid var(--line); border-radius:10px; background:#fff; }
.md h1, .md h2 { color:#fff; } .md h3, .md h4 { color:var(--accent); } .md p { white-space:pre-wrap; margin:6px 0; } .md pre { white-space:pre-wrap; background:#10162a; padding:8px; border-radius:6px; }
.split { display:grid; grid-template-columns:280px 1fr; gap:16px; } @media (max-width:800px) { .split { grid-template-columns:1fr; } }
.list button { display:block; width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--line); color:var(--ink); padding:7px 4px; cursor:pointer; font:inherit; }
.list button[aria-current=true] { color:var(--accent); }
.notice { padding:40px; text-align:center; } .notice a { color:var(--accent); }
@media (prefers-reduced-motion: no-preference) { .card { animation:rise .35s ease both; } @keyframes rise { from { opacity:0; transform:translateY(6px);} } }
</style>
</head>
<body>
<header><h1>Famigo Office 대시보드</h1><span class="muted" id="stamp"></span><span class="who" id="who"></span></header>
<nav id="tabs" role="tablist"></nav>
<main id="view"></main>
<script>
"use strict";
const $ = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};
const api = async (path) => {
  const r = await fetch(path, { credentials: "same-origin" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.status), { body, status: r.status });
  return body;
};
const view = document.getElementById("view");
const show = (...nodes) => view.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
const days = (n) => (n === null || n === undefined ? "미확인" : n + "일");
const statusTag = { review: ["결정 대기", "warn"], blocked: ["막힘", "bad"], todo: ["할 일", ""], done: ["완료", "ok"], archived: ["보관", ""] };
const tag = (text, kind = "") => $("span", { class: "tag " + kind }, text);
const list = (items, empty = "없음") => (items && items.length ? $("ul", {}, items.map((i) => $("li", {}, i))) : $("p", { class: "muted" }, empty));

// ── 마크다운: 원문을 HTML 로 해석하지 않는다. 블록만 나눠 textContent 로 그린다 ──
function markdown(text) {
  const root = $("div", { class: "md" });
  let para = [], listEl = null, fence = null;
  const flush = () => { if (para.length) root.append($("p", {}, para.join("\\n").replace(/\\*\\*/g, ""))); para = []; };
  for (const line of text.split("\\n")) {
    if (line.startsWith("\`\`\`")) { flush(); if (fence) { root.append($("pre", {}, fence.join("\\n"))); fence = null; } else fence = []; continue; }
    if (fence) { fence.push(line); continue; }
    const h = /^(#{1,4})\\s+(.*)$/.exec(line);
    const li = /^\\s*[-*]\\s+(.*)$/.exec(line);
    if (h) { flush(); listEl = null; root.append($("h" + h[1].length, {}, h[2].replace(/\\*\\*/g, ""))); }
    else if (li) { flush(); if (!listEl) { listEl = $("ul"); root.append(listEl); } listEl.append($("li", {}, li[1].replace(/\\*\\*/g, ""))); }
    else if (!line.trim()) { flush(); listEl = null; }
    else { listEl = null; para.push(line); }
  }
  flush();
  return root;
}

// ── 한 사람의 일 (나 · 관리자의 사람별 보기) ──
function personPanel(p) {
  const latest = p.daily_reports[0];
  const months = Object.entries(p.stats.by_month || {}).sort();
  const peak = Math.max(1, ...months.map(([, n]) => n));
  const nodes = [
    $("h2", {}, p.name, p.in_roster ? "" : "  ", p.in_roster ? null : tag("Lark 명단 밖", "warn")),
    $("div", { class: "card stats" },
      $("div", { class: "stat" }, $("b", {}, p.stats.messages), "Lark 발화"),
      $("div", { class: "stat" }, $("b", {}, p.daily_reports.length), "일일보고"),
      $("div", { class: "stat" }, $("b", {}, p.todos.filter((t) => ["todo", "review", "blocked"].includes(t.status)).length), "열린 장부"),
      $("div", { class: "stat" }, $("b", {}, p.stats.last || "—"), "마지막 발화"),
      months.length ? $("div", { style: "flex:1;min-width:200px" }, $("div", { class: "bar", title: "월별 발화" }, months.map(([m, n]) => $("span", { style: "height:" + Math.round((n / peak) * 100) + "%", title: m + " · " + n + "건" }))), $("div", { class: "muted" }, "월별 발화 " + months[0][0] + " ~ " + months[months.length - 1][0])) : null),
  ];
  if (latest) {
    nodes.push($("h2", {}, "최근 일일보고 ", $("span", { class: "muted" }, latest.date + " · " + latest.room)),
      $("div", { class: "grid" },
        $("div", { class: "card" }, $("h3", {}, "오늘 한 일"), list(latest.today)),
        $("div", { class: "card" }, $("h3", {}, "진행 중"), list(latest.doing)),
        $("div", { class: "card" }, $("h3", {}, "다음 할 일"), list(latest.next)),
        $("div", { class: "card" }, $("h3", {}, "우선순위"), ["high", "mid", "low"].flatMap((k) => latest.actions[k].length ? [$("div", { class: "muted" }, k.toUpperCase()), list(latest.actions[k])] : []), latest.actions.other.length ? list(latest.actions.other) : null, !["high", "mid", "low", "other"].some((k) => latest.actions[k].length) ? $("p", { class: "muted" }, "없음") : null),
        $("div", { class: "card" }, $("h3", {}, "막힘 · 이슈"), list(latest.blocked, "보고된 막힘 없음")),
        $("div", { class: "card" }, $("h3", {}, "지원 요청"), list(latest.support, "요청 없음"))));
    const history = p.daily_reports.slice(1, 15);
    if (history.length) nodes.push($("h2", {}, "지난 일일보고"), $("div", { class: "card" }, $("table", {}, $("tr", {}, $("th", {}, "날짜"), $("th", {}, "한 일"), $("th", {}, "막힘")), history.map((r) => $("tr", {}, $("td", {}, r.date), $("td", {}, r.today.slice(0, 3).join(" · ") + (r.today.length > 3 ? " 외 " + (r.today.length - 3) : "")), $("td", {}, r.blocked.join(" · ") || "—"))))));
  } else nodes.push($("p", { class: "muted" }, "일일보고 기록이 없습니다 (원문에 [일일보고] 머리가 있는 글만 셉니다)."));
  nodes.push($("h2", {}, "Lark 장부의 내 항목"), p.todos.length ? $("div", { class: "card" }, $("table", {}, $("tr", {}, $("th", {}, "항목"), $("th", {}, "상태"), $("th", {}, "경과"), $("th", {}, "방")), p.todos.map((t) => $("tr", {}, $("td", {}, t.id + " · " + t.title), $("td", {}, tag(...(statusTag[t.status] || [t.status])), t.stale ? tag("7일+ 방치", "bad") : null), $("td", {}, days(t.age_days)), $("td", {}, t.room || "—"))))) : $("p", { class: "muted" }, "담당으로 기록된 항목이 없습니다."));
  if (p.campaigns.length) nodes.push($("h2", {}, "맡은 캠페인"), $("div", { class: "card" }, list(p.campaigns)));
  if (p.local_layers && Object.keys(p.local_layers).length) {
    nodes.push($("h2", {}, "분석 층 ", tag("관리자 전용", "warn"), tag("추론·미검증", "bad")), $("div", { class: "card" }, $("pre", { style: "white-space:pre-wrap;margin:0" }, JSON.stringify(p.local_layers, null, 2))));
  }
  nodes.push($("h2", {}, "내가 쓴 글"), messageList(p.messages, { person: p.name }));
  return nodes;
}

function messageList(messages, { person = null, room = null } = {}) {
  const box = $("div", { class: "card" });
  const input = $("input", { type: "search", placeholder: "검색 (Enter)", "aria-label": "메시지 검색" });
  const rows = $("div");
  const render = (ms) => rows.replaceChildren(...(ms.length ? ms.map((m) => $("div", { class: "msg" }, $("div", { class: "meta" }, (m.ts || m.date || "").replace("T", " ") + " · " + m.room + (person ? "" : " · " + m.author) + (m.live ? " · 실시간" : "")), $("div", { class: "text" }, m.text))) : [$("p", { class: "muted" }, "메시지가 없습니다")]));
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const qs = new URLSearchParams({ q: input.value });
    if (person) qs.set("person", person);
    if (room) qs.set("room", room);
    render((await api("/api/search?" + qs)).messages);
  });
  render(messages);
  box.append($("div", { class: "row" }, input, $("span", { class: "muted" }, "최근 " + messages.length + "건")), rows);
  return box;
}

// ── 탭 ──
const TABS = {
  me: { label: "내 일", load: async (me) => personPanel(await api("/api/person?name=" + encodeURIComponent(me.person))) },
  team: { label: "팀 현황", load: async () => teamPanel(await api("/api/team")) },
  problems: { label: "문제 한눈에", admin: true, load: async () => problemsPanel(await api("/api/problems")) },
  people: { label: "사람별", admin: true, load: async () => peoplePanel(await api("/api/problems")) },
  rooms: { label: "방 원문", admin: true, load: async () => roomsPanel((await api("/api/rooms")).rooms) },
  reports: { label: "리포트 · 분석", admin: true, load: async () => reportsPanel((await api("/api/reports")).reports) },
  brief: { label: "브리핑 대시보드", load: async (me) => [$("p", { class: "muted" }, me.role === "admin" ? "예약 루틴이 매일 07:00 에 만드는 6탭 대시보드(전체판)" : "예약 루틴 대시보드(공유판)"), $("iframe", { src: "/view/dashboard?kind=" + (me.role === "admin" ? "full" : "share"), title: "브리핑 대시보드" })] },
};

function teamPanel(t) {
  const byStage = {};
  for (const c of t.pipeline) (byStage[c.stage] ??= []).push(c);
  return [
    $("div", { class: "card stats" },
      $("div", { class: "stat" }, $("b", {}, t.counts.todos_open), "열린 장부"),
      $("div", { class: "stat" }, $("b", {}, t.decisions.length), "결정 대기"),
      $("div", { class: "stat" }, $("b", {}, t.counts.todos_stale), "7일+ 방치"),
      $("div", { class: "stat" }, $("b", {}, t.pipeline.length), "캠페인 방"),
      $("div", { class: "stat" }, $("b", {}, t.hygiene.length), "좀비 후보"),
      $("div", { class: "stat" }, $("b", {}, t.counts.members), "구성원")),
    $("div", { class: "grid" },
      $("div", { class: "card" }, $("h3", {}, "결정 대기 (오래된 순)"), t.decisions.length ? $("ul", {}, t.decisions.slice(0, 12).map((d) => $("li", {}, d.id + " " + d.title + " — " + days(d.age_days)))) : $("p", { class: "muted" }, "없음")),
      $("div", { class: "card" }, $("h3", {}, "7일+ 방치"), t.stale.length ? $("ul", {}, t.stale.slice(0, 12).map((d) => $("li", {}, d.id + " " + d.title + " — " + days(d.age_days)))) : $("p", { class: "muted" }, "없음")),
      $("div", { class: "card" }, $("h3", {}, "좀비 후보 (진행·준비인데 21일+ 조용)"), t.hygiene.length ? $("ul", {}, t.hygiene.map((h) => $("li", {}, h.room + " (" + h.stage + ") — " + h.quiet_days + "일"))) : $("p", { class: "muted" }, "없음"))),
    $("h2", {}, "캠페인 파이프라인 (방 이름 접두사 기준)"),
    $("div", { class: "grid" }, Object.entries(byStage).map(([stage, cs]) => $("div", { class: "card" }, $("h3", {}, stage + " " + cs.length), $("ul", {}, cs.map((c) => $("li", {}, c.title, " ", c.zombie ? tag("좀비", "bad") : null, $("span", { class: "muted" }, " · " + days(c.quiet_days) + " 조용"))))))),
    $("p", { class: "muted" }, "기준 " + t.generated_at + " · Lark 브리핑 데이터 (반출 게이트 통과)"),
  ];
}

function problemsPanel(p) {
  const items = (rows) => rows.length ? $("table", {}, $("tr", {}, $("th", {}, "사람"), $("th", {}, "보고일"), $("th", {}, "내용")), rows.map((r) => $("tr", { class: "click", onclick: () => openPerson(r.name) }, $("td", {}, r.name), $("td", {}, r.date), $("td", {}, list(r.items))))) : $("p", { class: "muted" }, "없음");
  return [
    $("h2", {}, "최신 일일보고의 막힘 · 이슈"), $("div", { class: "card" }, items(p.blocked)),
    $("h2", {}, "지원 요청"), $("div", { class: "card" }, items(p.support)),
    p.decisions_brief ? [$("h2", {}, "오늘 결정할 것 ", $("span", { class: "muted" }, p.decisions_brief.source)), $("div", { class: "card" }, list(p.decisions_brief.items))] : null,
    ...(p.team ? teamPanel(p.team).slice(0, 2) : []),
    p.coverage ? $("p", { class: "muted" }, "원문 " + p.coverage.messages + "건 (실시간 " + p.coverage.live_messages + ") · 원문 파일 " + p.coverage.raw_files + (p.coverage.unresolved_authors.length ? " · 이름 미해결 " + p.coverage.unresolved_authors.join(", ") : "")) : null,
  ];
}

function peoplePanel(p) {
  return [$("div", { class: "card" }, $("table", {},
    $("tr", {}, $("th", {}, "사람"), $("th", {}, "마지막 발화"), $("th", {}, "발화"), $("th", {}, "일일보고"), $("th", {}, "최근 보고"), $("th", {}, "막힘"), $("th", {}, "열린 장부")),
    p.people.map((r) => $("tr", { class: "click", onclick: () => openPerson(r.name) },
      $("td", {}, r.name, r.in_roster ? "" : " ", r.in_roster ? null : tag("명단 밖", "warn")),
      $("td", {}, r.last || "—"), $("td", {}, r.messages), $("td", {}, r.reports), $("td", {}, r.latest_report?.date || "—"),
      $("td", {}, r.latest_report?.blocked?.length ? tag(r.latest_report.blocked.length + "건", "bad") : "—"), $("td", {}, r.open_todos)))))];
}

async function openPerson(name) {
  select("people", false);
  show($("p", { class: "muted" }, "불러오는 중…"));
  show($("button", { class: "more", onclick: () => select("people") }, "← 사람 목록"), ...personPanel(await api("/api/person?name=" + encodeURIComponent(name))));
}

function roomsPanel(rooms) {
  const side = $("div", { class: "list card" });
  const body = $("div");
  const open = async (r, btn) => {
    side.querySelectorAll("button").forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "true");
    const data = await api("/api/room?name=" + encodeURIComponent(r.name));
    body.replaceChildren($("h2", {}, r.name, " ", $("span", { class: "muted" }, r.count + "건 · " + r.first + " ~ " + r.last)), messageList(data.messages, { room: r.name }));
  };
  rooms.forEach((r) => { const b = $("button", {}, r.name, $("div", { class: "muted" }, r.count + "건 · 마지막 " + r.last)); b.addEventListener("click", () => open(r, b)); side.append(b); });
  body.append($("p", { class: "muted" }, "왼쪽에서 방을 고르세요."));
  return [$("div", { class: "split" }, side, body)];
}

function reportsPanel(reports) {
  const kinds = { brief: "브리핑", daily: "일간", weekly: "주간", monthly: "월간", analysis: "종합 분석" };
  const filter = $("select", { "aria-label": "종류" }, $("option", { value: "" }, "전체"), Object.entries(kinds).map(([k, v]) => $("option", { value: k }, v)));
  const side = $("div", { class: "list card" });
  const body = $("div", {}, $("p", { class: "muted" }, "왼쪽에서 리포트를 고르세요."));
  const fill = () => {
    side.replaceChildren(...reports.filter((r) => !filter.value || r.kind === filter.value).map((r) => {
      const b = $("button", {}, r.title, $("div", { class: "muted" }, kinds[r.kind] + (r.date ? " · " + r.date : "")));
      b.addEventListener("click", async () => {
        side.querySelectorAll("button").forEach((x) => x.removeAttribute("aria-current"));
        b.setAttribute("aria-current", "true");
        const doc = await api("/api/report?id=" + encodeURIComponent(r.id));
        body.replaceChildren($("div", { class: "card" }, markdown(doc.text)));
      });
      return b;
    }));
  };
  filter.addEventListener("change", fill);
  fill();
  return [$("div", { class: "row" }, filter, $("span", { class: "muted" }, reports.length + "건")), $("div", { class: "split" }, side, body)];
}

// ── 시작 ──
let ME = null;
function select(key, load = true) {
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.key === key)));
  if (!load) return;
  show($("p", { class: "muted" }, "불러오는 중…"));
  TABS[key].load(ME).then((nodes) => show(...[nodes].flat(Infinity).filter(Boolean))).catch((e) => show($("div", { class: "notice" }, e.message)));
}

(async () => {
  ME = await api("/api/me");
  if (!ME.signed_in) return show($("div", { class: "notice" }, "사무실에 먼저 로그인하세요. ", $("a", { href: ME.login_url }, "사무실 로그인")));
  if (!ME.linked) return show($("div", { class: "notice" }, ME.nickname + " 계정이 아직 Lark 사람과 연결되지 않았습니다. 관리자(Dylan)에게 연결을 요청하세요."));
  document.getElementById("who").textContent = ME.nickname + " · " + ME.person + (ME.role === "admin" ? " · 관리자" : "");
  document.getElementById("stamp").textContent = ME.generated_at ? "기준 " + ME.generated_at : "";
  const tabs = document.getElementById("tabs");
  for (const [key, t] of Object.entries(TABS)) {
    if (t.admin && ME.role !== "admin") continue;
    tabs.append($("button", { role: "tab", "data-key": key, "aria-selected": "false", onclick: () => select(key) }, t.label));
  }
  select(ME.role === "admin" ? "problems" : "me");
})();
</script>
</body>
</html>`;
}
