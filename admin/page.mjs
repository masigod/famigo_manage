// 관리자 화면 — 자립 HTML 한 장(외부 리소스 0). Lark 에서 온 이름은 textContent 로만 넣는다(XSS 차단).

export function renderAdminPage() {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Famigo Office 관리자</title>
<style>
  :root {
    --bg: #f6f5f1; --panel: #ffffff; --ink: #1d2433; --muted: #667085; --line: #e4e2dc;
    --accent: #c9861f; --accent-ink: #ffffff; --ok: #2f7d4f; --warn: #b54708; --off: #98a2b3;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141b2e; --panel: #1b2338; --ink: #e6ebf5; --muted: #98a2b3; --line: #2c3650;
            --accent: #e8a33d; --accent-ink: #141b2e; --ok: #6fcf97; --warn: #f5a524; --off: #667085; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line);
           padding: 14px 24px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 12px; }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); }
  .pill.run { border-color: var(--accent); color: var(--accent); }
  .pill.bad { border-color: var(--warn); color: var(--warn); }
  .pill.good { border-color: var(--ok); color: var(--ok); }
  main { max-width: 1180px; margin: 0 auto; padding: 20px 24px 60px; display: grid; gap: 20px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
  .sec-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .sec-head h2 { font-size: 15px; margin: 0; }
  .sec-head p { margin: 0; color: var(--muted); font-size: 12px; flex: 1 1 240px; }
  .tabs { display: flex; gap: 4px; }
  .tabs button { border: 1px solid var(--line); background: transparent; color: var(--ink); border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 12px; }
  .tabs button[aria-pressed="true"] { background: var(--ink); color: var(--panel); border-color: var(--ink); }
  input[type=search] { border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 8px; padding: 6px 10px; font: inherit; min-width: 180px; }
  .rows { display: grid; }
  .row { display: grid; grid-template-columns: minmax(150px, 1.2fr) repeat(3, minmax(100px, 1fr)) minmax(96px, .7fr) minmax(170px, 1.3fr) auto;
         gap: 10px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--line); }
  .row:first-child { border-top: 0; }
  .row.off { opacity: .55; }
  .who b { display: block; font-size: 14px; }
  .who span { color: var(--muted); font-size: 12px; }
  .row input, .row select { width: 100%; border: 1px solid var(--line); background: var(--bg); color: var(--ink);
                            border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px; }
  .row input:disabled, .row select:disabled { opacity: .6; }
  .actions { display: flex; gap: 6px; justify-content: flex-end; }
  button.act { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 13px; white-space: nowrap; }
  button.act.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  button.act.danger { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  button.act:disabled { opacity: .5; cursor: default; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .empty { padding: 18px 16px; color: var(--muted); }
  .row.access { grid-template-columns: minmax(150px, 1fr) minmax(200px, 3fr) auto; }
  .row.account { grid-template-columns: minmax(180px, 1.4fr) minmax(160px, 1fr) minmax(130px, .8fr) auto; }
  code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); border: 1px solid var(--line);
         border-radius: 8px; padding: 6px 10px; overflow-wrap: anywhere; }
  details { padding: 12px 16px; }
  summary { cursor: pointer; color: var(--muted); }
  pre { white-space: pre-wrap; font-size: 12px; background: var(--bg); border-radius: 8px; padding: 12px; max-height: 320px; overflow: auto; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--panel);
           padding: 8px 16px; border-radius: 999px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  @media (max-width: 860px) {
    .row { grid-template-columns: 1fr 1fr; }
    .who, .actions { grid-column: 1 / -1; }
    .actions { justify-content: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
</style>
</head>
<body>
<header>
  <h1>Famigo Office 관리자</h1>
  <span class="meta" id="basis">불러오는 중…</span>
  <span class="pill" id="sync">동기화 상태 확인 중</span>
</header>
<main>
  <section aria-labelledby="h-access">
    <div class="sec-head">
      <h2 id="h-access">팀원 초대</h2>
      <p>팀원에게는 아래 세 가지만 알려 주세요. 소유자·관리자 비밀번호는 알려 주지 않습니다.</p>
    </div>
    <div class="rows" id="access"></div>
  </section>
  <section aria-labelledby="h-accounts">
    <div class="sec-head">
      <h2 id="h-accounts">대시보드 계정 연결</h2>
      <p id="accounts-note">사무실에 가입한 계정을 Lark 사람과 잇습니다. 연결된 계정만 대시보드와 1:1 대화에서 자기 일을 봅니다. 관리자는 전부를 봅니다. 닉네임만으로는 아무 권한도 생기지 않습니다.</p>
    </div>
    <div class="rows" id="accounts"></div>
  </section>
  <section aria-labelledby="h-members">
    <div class="sec-head">
      <h2 id="h-members">직원</h2>
      <p>명단은 Lark 가 정본입니다. 여기서는 사무실에 앉힐지와 보이는 모습만 정합니다. 저장하면 사무실에 바로 반영됩니다.</p>
      <div class="tabs" role="group" aria-label="보기">
        <button data-f="on" aria-pressed="true">근무 중</button>
        <button data-f="off" aria-pressed="false">퇴장</button>
        <button data-f="all" aria-pressed="false">전체</button>
      </div>
      <input type="search" id="q" placeholder="이름 검색" aria-label="이름 검색">
    </div>
    <div class="rows" id="members"></div>
  </section>
  <section aria-labelledby="h-departed">
    <div class="sec-head">
      <h2 id="h-departed">퇴장 후보</h2>
      <p>사무실에 앉아 있지만 지금 Lark 명단에 없는 사람입니다. 자동으로 지우지 않습니다 — 확인 후 퇴장시키세요.</p>
    </div>
    <div class="rows" id="departed"></div>
  </section>
  <section aria-labelledby="h-log">
    <details>
      <summary id="h-log">마지막 반영 기록</summary>
      <pre id="log">아직 없음</pre>
    </details>
  </section>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
(() => {
  let state = null, filter = "on", poll = null;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k) n.append(k);
    return n;
  };
  const toast = (msg) => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2200); };

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Famigo-Admin": "1" }, body: JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    return data;
  }

  async function load() {
    const r = await fetch("/api/state", { cache: "no-store" });
    state = await r.json();
    render();
    const running = state.sync.running || state.sync.pending;
    if (running && !poll) poll = setInterval(load, 2000);
    if (!running && poll) { clearInterval(poll); poll = null; }
  }

  function renderSync() {
    const s = state.sync, pill = $("sync");
    pill.className = "pill";
    if (s.running || s.pending) { pill.textContent = "사무실에 반영 중…"; pill.classList.add("run"); }
    else if (s.lastExit === null) { pill.textContent = "대기"; }
    else if (s.lastExit === 0) { pill.textContent = "반영 완료 · " + new Date(s.lastAt).toLocaleTimeString("ko-KR"); pill.classList.add("good"); }
    else { pill.textContent = "반영 실패 — 기록 확인"; pill.classList.add("bad"); }
    $("log").textContent = s.log || "아직 없음";
    $("basis").textContent = "Lark 명단 " + (state.roster_generated_at ? new Date(state.roster_generated_at).toLocaleString("ko-KR") : "없음")
      + " · 사무실 데이터 " + (state.office_generated_at ? new Date(state.office_generated_at).toLocaleString("ko-KR") : "없음");
  }

  function bodySelect(value, disabled) {
    const s = el("select", { "aria-label": "몸형", disabled, title: "대화에는 성별 근거가 없어 사람이 정합니다" });
    for (const [v, t] of [["", "몸형 유지"], ["female", "여성형"], ["male", "남성형"]]) s.append(el("option", { value: v, text: t, selected: v === value }));
    return s;
  }

  function lookSelect(value, disabled, persona) {
    const s = el("select", { "aria-label": "외형", disabled });
    const auto = persona && persona.look ? state.looks.find((l) => l.id === persona.look) : null;
    s.append(el("option", { value: "", text: auto ? "자동 — " + auto.name + " (말투 분석)" : "자동 배정" }));
    for (const l of state.looks) s.append(el("option", { value: l.id, text: l.name + " — " + l.subtitle, selected: l.id === value }));
    return s;
  }

  function memberRow(m) {
    const off = m.excluded;
    const input = (value, placeholder, label) => el("input", { value, placeholder, "aria-label": label, disabled: off });
    const dn = input(m.display_name, m.name, "표시 이름");
    const role = input(m.role, "직무", "직무");
    const team = input(m.team, "팀", "팀");
    const body = bodySelect(m.body, off);
    const look = lookSelect(m.look, off, m.persona);
    const kinds = { leadership: "리더십", creative: "크리에이티브", casual: "캐주얼", classic: "클래식" };
    const sub = [m.rooms + "개 방", m.last_active ? "최근 발화 " + m.last_active : "최근 발화 기록 없음",
                 m.reports !== null ? "일일보고 " + m.reports + "회" : null,
                 m.persona ? "말투 분석: " + (kinds[m.persona.category] || m.persona.category) : null].filter(Boolean).join(" · ");
    const save = el("button", { class: "act primary", text: "저장", disabled: off, onclick: async () => {
      save.disabled = true;
      try { await post("/api/member", { name: m.name, action: "update", display_name: dn.value, role: role.value, team: team.value, body: body.value, look: look.value }); toast(m.name + " 저장 — 사무실에 반영 중"); await load(); }
      catch (e) { toast("저장 실패: " + e.message); save.disabled = false; }
    }});
    const toggle = el("button", { class: "act " + (off ? "" : "danger"), text: off ? "복귀" : "퇴장", onclick: async () => {
      if (!off && !confirm(m.name + " 님을 사무실에서 퇴장시킬까요? (Lark 에는 영향 없음 · 언제든 복귀 가능)")) return;
      toggle.disabled = true;
      try { await post("/api/member", { name: m.name, action: off ? "include" : "exclude" }); toast(m.name + (off ? " 복귀" : " 퇴장") + " — 반영 중"); await load(); }
      catch (e) { toast("실패: " + e.message); toggle.disabled = false; }
    }});
    return el("div", { class: "row" + (off ? " off" : "") },
      el("div", { class: "who", title: m.persona ? m.persona.evidence + "\\n몸형: " + m.persona.body_source : "" }, el("b", { text: m.name }), el("span", { text: off ? "퇴장 · " + sub : sub })),
      dn, role, team, body, look, el("div", { class: "actions" }, save, toggle));
  }

  function copyRow(label, value, note) {
    const b = el("button", { class: "act", text: "복사", disabled: !value, onclick: async () => {
      try { await navigator.clipboard.writeText(value); toast(label + " 복사됨"); } catch { toast("복사 실패 — 직접 선택하세요"); }
    }});
    return el("div", { class: "row access" },
      el("div", { class: "who" }, el("b", { text: label }), el("span", { text: note || "" })),
      el("code", { text: value || "—" }), el("div", { class: "actions" }, b));
  }

  function renderAccess() {
    const a = state.access || {};
    const box = $("access");
    if (!a.lan) {
      box.replaceChildren(el("div", { class: "empty", text: "지금은 이 Mac 에서만 사무실이 열려 있습니다. 팀원을 들이려면 터미널에서  bash scripts/install-mac.sh --lan  을 실행하세요." }));
      return;
    }
    box.replaceChildren(
      copyRow("1. 사무실 주소", a.office_url, "같은 와이파이·사내망에서 열고 각자 가입"),
      copyRow("2. 초대 링크", a.invite_url, a.invite_url ? "가입 후 이 링크로 들어옴" : "사무실 반영 후 생성됩니다"),
      copyRow("3. 채널 비밀번호", a.channel_password, "초대 링크에서 입력"),
    );
  }

  function accountRow(u) {
    const a = state.accounts;
    const linked = a.linked[u.id];
    const sub = (u.loginId || "") + (u.createdAt ? " · 가입 " + String(u.createdAt).slice(0, 10) : "");
    if (u.id === a.owner_user_id && !linked) {
      return el("div", { class: "row account" },
        el("div", { class: "who" }, el("b", { text: u.nickname }), el("span", { text: sub })),
        el("div", { text: a.owner_person || "Dylan" }), el("div", { text: "관리자" }),
        el("div", { class: "actions" }, el("span", { class: "meta", text: "사무실 소유자 — 자동" })));
    }
    const person = el("select", { "aria-label": "Lark 사람" });
    person.append(el("option", { value: "", text: "— 연결 안 함 —" }));
    for (const n of a.persons) person.append(el("option", { value: n, text: n, selected: linked && linked.person === n }));
    const role = el("select", { "aria-label": "역할" });
    for (const [v, t] of [["member", "팀원 — 자기 것 + 팀 현황"], ["admin", "관리자 — 전부"]]) role.append(el("option", { value: v, text: t, selected: linked ? linked.role === v : v === "member" }));
    const save = el("button", { class: "act primary", text: "저장", onclick: async () => {
      save.disabled = true;
      try {
        if (!person.value) await post("/api/account", { action: "unlink_account", userId: u.id });
        else {
          if (role.value === "admin" && !confirm(u.nickname + " 계정에 관리자(모든 원문·분석·L2·L3 열람) 권한을 줄까요?")) { save.disabled = false; return; }
          await post("/api/account", { action: "link_account", userId: u.id, person: person.value, role: role.value });
        }
        toast(u.nickname + " 연결 저장 — 바로 적용"); await load();
      } catch (e) { toast("저장 실패: " + e.message); save.disabled = false; }
    }});
    return el("div", { class: "row account" + (linked ? "" : " off") },
      el("div", { class: "who" }, el("b", { text: u.nickname }), el("span", { text: sub + (linked ? "" : " · 연결 안 됨") })),
      person, role, el("div", { class: "actions" }, save));
  }

  function signupRow(a) {
    const closed = a.signup === "closed";
    const b = el("button", { class: "act " + (closed ? "primary" : "danger"), text: closed ? "가입 열기" : "가입 닫기", onclick: async () => {
      b.disabled = true;
      try { await post("/api/account", { action: "signup", value: closed ? "open" : "closed" }); toast(closed ? "가입을 열었습니다" : "가입을 닫았습니다 — 로그인은 그대로"); await load(); }
      catch (e) { toast("실패: " + e.message); b.disabled = false; }
    }});
    return el("div", { class: "row access" },
      el("div", { class: "who" }, el("b", { text: "새 계정 가입" }), el("span", { text: closed ? "닫힘 — 새 계정을 만들 수 없습니다" : "열림 — 같은 네트워크의 누구나 계정을 만들 수 있습니다" })),
      el("span", { class: "meta", text: "팀원이 모두 가입했으면 닫으세요. 사무실 안은 채널 비밀번호로 한 번 더 막혀 있습니다." }),
      el("div", { class: "actions" }, b));
  }

  function renderAccounts() {
    const a = state.accounts;
    const box = $("accounts");
    if (a.dashboard_url) $("accounts-note").textContent = "대시보드: " + a.dashboard_url + " — 사무실 로그인 그대로 열립니다. 연결된 계정만 자기 일을 보고, 관리자는 전부를 봅니다. 닉네임만으로는 아무 권한도 생기지 않습니다.";
    if (a.error) { box.replaceChildren(el("div", { class: "empty", text: a.error })); return; }
    box.replaceChildren(signupRow(a), ...(a.users.length ? a.users.map(accountRow) : [el("div", { class: "empty", text: "사무실에 가입한 계정이 없습니다." })]));
  }

  function render() {
    renderSync();
    renderAccess();
    renderAccounts();
    const q = $("q").value.trim().toLowerCase();
    const list = state.members
      .filter((m) => filter === "all" || (filter === "on" ? !m.excluded : m.excluded))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q));
    const box = $("members");
    box.replaceChildren(...(list.length ? list.map(memberRow) : [el("div", { class: "empty", text: "해당하는 사람이 없습니다." })]));
    const dep = $("departed");
    dep.replaceChildren(...(state.departed.length ? state.departed.map((d) => {
      const b = el("button", { class: "act danger", text: "퇴장 확정", onclick: async () => {
        if (!confirm(d.display_name + " 님을 사무실에서 내보낼까요?")) return;
        b.disabled = true;
        try { await post("/api/member", { name: d.display_name, action: "retire_departed", key: d.key }); toast(d.display_name + " 퇴장 — 반영 중"); await load(); }
        catch (e) { toast("실패: " + e.message); b.disabled = false; }
      }});
      return el("div", { class: "row" }, el("div", { class: "who" }, el("b", { text: d.display_name }), el("span", { text: "Lark 명단에 없음" })),
        el("div"), el("div"), el("div"), el("div"), el("div"), el("div", { class: "actions" }, b));
    }) : [el("div", { class: "empty", text: "없음 — 사무실 직원이 모두 Lark 명단에 있습니다." })]));
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.f;
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));
  $("q").addEventListener("input", render);
  load().catch((e) => { $("basis").textContent = "상태를 못 불러왔습니다: " + e.message; });
})();
</script>
</body>
</html>`;
}
