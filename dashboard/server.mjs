// Famigo 대시보드 — 예약 루틴(Lark 브리핑)의 결과를 사람별·관리자별로 보여 주는 웹 (사무실 포트 + 2).
//
// 무엇을: 누가 무엇을 하고 있는가(일일보고·담당), 진행에 무엇이 막혔는가(막힘·지원 요청·방치 결정·좀비 방),
//         어떤 분석이 나와 있는가(브리핑·일간·주간·월간·종합 분석·6탭 대시보드).
// 누가 무엇을: gateway/access.mjs 의 규칙 하나. 서버가 역할에 맞춰 **자르고 나서** 보낸다 — 화면에서 숨기는
//             것이 아니다. 팀원의 응답에는 다른 사람의 원문이 애초에 들어 있지 않다.
// 로그인: 따로 없다. 사무실(DeskRPG) 로그인 쿠키를 그대로 검증한다(쿠키는 포트를 가리지 않는다).
//
// 보안: 응답은 JSON 과 이 파일이 만든 페이지뿐 — 원문은 화면에서 textContent 로만 그린다(XSS 차단).
//       Host 가 이 Mac 의 이름·LAN 주소가 아니면 거절(DNS 리바인딩). 교차 출처 허용 헤더 없음.

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { canSeePerson, createIdentitySource, isAdmin, readCookie, verifyJwt } from "../gateway/access.mjs";
import { renderDashboardPage } from "./page.mjs";

const OPEN = new Set(["todo", "review", "blocked"]);

function cachedJson(path) {
  let cache = null;
  let mtime = -1;
  return () => {
    if (!existsSync(path)) return null;
    const m = statSync(path).mtimeMs;
    if (m !== mtime) {
      cache = JSON.parse(readFileSync(path, "utf8"));
      mtime = m;
    }
    return cache;
  };
}

export function localHostnames() {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4")
    .map((i) => i.address);
  return new Set(["localhost", "127.0.0.1", "[::1]", ...ips]);
}

const hostnameOf = (host) => String(host ?? "").replace(/:\d+$/, "").toLowerCase();

// ---------------------------------------------------------------------------
// 조립 — 역할에 맞춰 자른 응답 (순수 함수, 테스트 대상)
// ---------------------------------------------------------------------------

export function personView(insights, name, who, { messages = 100, before = null } = {}) {
  const p = insights?.persons?.[name];
  if (!p || !canSeePerson(who, name)) return null;
  const mine = insights.messages.filter((m) => m.author === name && (!before || m.ts < before));
  const todos = p.todos.map((id) => insights.todos[id]).filter(Boolean);
  return {
    name,
    in_roster: p.in_roster,
    stats: p.stats,
    activity: p.L1 ?? {},
    daily_reports: p.daily_reports.slice(0, 60),
    todos: todos.map((t) => ({ id: t.id, title: t.title, status: t.board_status, source_status: t.status, kind: t.kind, age_days: t.age_days, stale: t.stale, room: t.room, due: t.due })),
    campaigns: p.campaigns,
    messages: mine.slice(-messages).reverse(),
    has_more: mine.length > messages,
    // L2·L3 는 관리자만 — 추론·미검증(스킬 §0.9)
    ...(isAdmin(who) ? { local_layers: p.local_layers } : {}),
  };
}

export function teamView(office) {
  if (!office) return null;
  const ledger = office.boards.ledger;
  return {
    generated_at: office.generated_at,
    daily: office.daily,
    counts: office.counts,
    decisions: ledger.filter((t) => t.status === "review").sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0)),
    stale: ledger.filter((t) => t.stale && t.status !== "review").sort((a, b) => (b.age_days ?? 0) - (a.age_days ?? 0)),
    blocked: ledger.filter((t) => t.status === "blocked"),
    pipeline: office.boards.pipeline,
    hygiene: office.hygiene,
    members: office.members.filter((m) => m.kind === "member").map((m) => ({ key: m.key, name: m.display_name, role: m.role, team: m.team })),
  };
}

/** 관리자: 진행에 문제가 무엇인가 — 각자의 최신 일일보고에서 막힘·지원 요청, 장부에서 오래된 결정. */
export function problemsView(insights, office) {
  const people = Object.values(insights?.persons ?? {})
    .map((p) => {
      const latest = p.daily_reports[0] ?? null;
      const open = p.todos.map((id) => insights.todos[id]).filter((t) => t && OPEN.has(t.board_status));
      return {
        name: p.name,
        in_roster: p.in_roster,
        messages: p.stats.messages,
        last: p.stats.last,
        reports: p.daily_reports.length,
        latest_report: latest ? { date: latest.date, blocked: latest.blocked, support: latest.support, next: latest.next } : null,
        open_todos: open.length,
      };
    })
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""));
  return {
    people,
    blocked: people.filter((p) => p.latest_report?.blocked?.length).map((p) => ({ name: p.name, date: p.latest_report.date, items: p.latest_report.blocked })),
    support: people.filter((p) => p.latest_report?.support?.length).map((p) => ({ name: p.name, date: p.latest_report.date, items: p.latest_report.support })),
    team: teamView(office),
    decisions_brief: insights?.decisions ?? null,
    coverage: insights?.coverage ?? null,
  };
}

export function searchMessages(insights, who, q, { person = null, room = null, limit = 200 } = {}) {
  const needle = String(q ?? "").trim().toLowerCase();
  const onlyMine = !isAdmin(who);
  return insights.messages
    .filter((m) => (onlyMine ? m.author === who.person : !person || m.author === person))
    .filter((m) => !room || m.room === room)
    .filter((m) => !needle || m.text.toLowerCase().includes(needle))
    .slice(-limit)
    .reverse();
}

// ---------------------------------------------------------------------------
// 서버
// ---------------------------------------------------------------------------

export function createDashboard({ root, briefsDir, jwtSecret, deskPort = 3300, allowedHosts = localHostnames() }) {
  if (!jwtSecret) throw new Error("DeskRPG JWT 비밀이 필요하다 (로그인 쿠키 검증)");
  const insights = cachedJson(join(root, "out", "insights.json"));
  const office = cachedJson(join(root, "out", "office.json"));
  const identity = createIdentitySource({
    configPath: join(root, "config", "office.config.json"),
    seedStatePath: join(root, "out", "seed_state.json"),
  });
  const briefsRoot = resolve(briefsDir);

  const send = (res, status, body, type = "application/json; charset=utf-8", extra = {}) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; frame-ancestors 'self'",
      ...extra,
    });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  /** 색인에 있는 파일만, 그리고 briefs 폴더 안의 것만 연다(경로 조작 차단). */
  const briefsFile = (rel) => {
    const full = resolve(briefsRoot, rel);
    return full.startsWith(briefsRoot + sep) && existsSync(full) ? full : null;
  };

  return createServer((req, res) => {
    const handle = async () => {
      if (!allowedHosts.has(hostnameOf(req.headers.host)))
        return send(res, 403, { error: "이 주소로는 열 수 없습니다" });
      if (req.method !== "GET") return send(res, 405, { error: "읽기 전용입니다" });
      const url = new URL(req.url ?? "/", "http://dashboard.local");
      if (url.pathname === "/") return send(res, 200, renderDashboardPage(), "text/html; charset=utf-8");

      const session = verifyJwt(readCookie(req.headers.cookie, "token"), jwtSecret);
      const who = session ? identity(session.userId) : null;
      const deskLogin = `http://${hostnameOf(req.headers.host)}:${deskPort}/auth`;
      if (url.pathname === "/api/me") {
        return send(res, 200, {
          signed_in: Boolean(session),
          nickname: session?.nickname ?? null,
          linked: Boolean(who),
          person: who?.person ?? null,
          role: who?.role ?? null,
          login_url: deskLogin,
          generated_at: insights()?.generated_at ?? null,
        });
      }
      if (!session) return send(res, 401, { error: "사무실에 먼저 로그인하세요", login_url: deskLogin });
      if (!who) return send(res, 403, { error: "관리자가 이 계정을 Lark 사람과 연결해야 볼 수 있습니다" });
      const data = insights();
      if (!data) return send(res, 503, { error: "인사이트가 아직 없습니다 (bash scripts/office.sh build)" });

      const q = url.searchParams;
      switch (url.pathname) {
        case "/api/team":
          return send(res, 200, teamView(office()));
        case "/api/person": {
          const name = q.get("name") || who.person;
          const view = personView(data, name, who, { before: q.get("before") });
          return view ? send(res, 200, view) : send(res, 403, { error: "볼 수 없는 사람입니다" });
        }
        case "/api/search":
          return send(res, 200, { messages: searchMessages(data, who, q.get("q"), { person: q.get("person"), room: q.get("room") }) });
      }
      // ── 여기부터 관리자 전용 ──
      if (url.pathname === "/view/dashboard") {
        const kind = q.get("kind") === "full" && isAdmin(who) ? "full" : "share";
        const file = data.dashboards?.[kind] && briefsFile(data.dashboards[kind]);
        if (!file) return send(res, 404, { error: "대시보드 파일이 없습니다" });
        // 예약 루틴의 대시보드는 JS 없이 도는 자립 HTML(스킬 §8) — 스크립트를 막고 띄운다.
        return send(res, 200, readFileSync(file), "text/html; charset=utf-8", { "Content-Security-Policy": "sandbox; frame-ancestors 'self'" });
      }
      if (!isAdmin(who)) return send(res, 403, { error: "관리자만 볼 수 있습니다" });
      switch (url.pathname) {
        case "/api/problems":
          return send(res, 200, problemsView(data, office()));
        case "/api/rooms":
          return send(res, 200, { rooms: Object.values(data.rooms) });
        case "/api/room": {
          const room = q.get("name");
          const before = q.get("before");
          const all = data.messages.filter((m) => m.room === room && (!before || m.ts < before));
          return send(res, 200, { room, messages: all.slice(-200).reverse(), has_more: all.length > 200 });
        }
        case "/api/reports":
          return send(res, 200, { reports: data.reports });
        case "/api/report": {
          const item = data.reports.find((r) => r.id === q.get("id"));
          const file = item && briefsFile(item.id);
          if (!file) return send(res, 404, { error: "리포트가 없습니다" });
          return send(res, 200, { ...item, text: readFileSync(file, "utf8") });
        }
      }
      return send(res, 404, { error: "not_found" });
    };
    handle().catch((e) => {
      console.error(`[famigo-dashboard] ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: "대시보드 오류" });
    });
  });
}
