// 대시보드·1:1 대화 권한 회귀 테스트 — "누가 무엇을 보는가"를 고정한다.
// 실행: node --test tests/*.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { canSeePerson, identityOf, signJwt, verifyJwt } from "../gateway/access.mjs";
import { askerOf, personalReply } from "../gateway/personal.mjs";
import { createDashboard } from "../dashboard/server.mjs";
import { renderDashboardPage } from "../dashboard/page.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "test-jwt-secret-0123456789abcdef";
const IDS = {
  owner: "00000000-0000-4000-8000-000000000001",
  echo: "00000000-0000-4000-8000-000000000002",
  bravo: "00000000-0000-4000-8000-000000000003",
  stranger: "00000000-0000-4000-8000-000000000004",
};
let root, briefs, server, port, office;

const report = (who, blocked) => ({
  date: "2026-09-26", ts: "2026-09-26T19:00:00", room: "일일업무", msg_id: `r-${who}`,
  today: [`${who} 가상 업무`], doing: [], next: [`${who} 다음`], blocked, support: [],
  actions: { high: [], mid: [], low: [], other: [] },
});
const person = (name, extra = {}) => ({
  name, in_roster: true,
  stats: { messages: 1, rooms: { 일일업무: 1 }, first: "2026-09-26", last: "2026-09-26", by_month: { "2026-09": 1 } },
  daily_reports: [report(name, name === "Alpha Kim" ? ["가상 막힘"] : [])],
  todos: [], campaigns: [], L1: { msgs: 1 }, local_layers: { L3_성격추론: ["ALPHA-L3-SECRET"] }, ...extra,
});

before(async () => {
  root = mkdtempSync(join(tmpdir(), "famigo-dash-"));
  briefs = join(root, "briefs");
  mkdirSync(join(root, "out"));
  mkdirSync(join(root, "config"));
  mkdirSync(join(briefs, "dashboard"), { recursive: true });
  mkdirSync(join(briefs, "reports", "_analysis"), { recursive: true });
  writeFileSync(join(briefs, "dashboard", "lark_dashboard.html"), "<p>FULL-DASHBOARD</p>");
  writeFileSync(join(briefs, "dashboard", "lark_dashboard_share.html"), "<p>SHARE-DASHBOARD</p>");
  writeFileSync(join(briefs, "reports", "_analysis", "a.md"), "# 가상 종합 분석\n");
  writeFileSync(join(root, "secret.md"), "OUTSIDE-BRIEFS");
  execFileSync("python3", [join(ROOT, "office/build_office.py"), "--data-dir", join(ROOT, "tests/fixtures/briefs/data"),
    "--out", join(root, "out", "office.json"), "--now", "2026-09-27T08:00:00+09:00"]);
  office = JSON.parse((await import("node:fs")).readFileSync(join(root, "out", "office.json"), "utf8"));
  const insights = {
    schema: 1, generated_at: "2026-09-27T08:00:00+09:00",
    persons: { "Alpha Kim": person("Alpha Kim", { todos: ["T001"] }), "Bravo Lee": person("Bravo Lee"), Dylan: person("Dylan") },
    rooms: { 일일업무: { name: "일일업무", count: 3, first: "2026-09-26", last: "2026-09-26", dm: false } },
    messages: [
      { id: "1", ts: "2026-09-26T10:00:00", date: "2026-09-26", room: "일일업무", author: "Alpha Kim", text: "ALPHA-PRIVATE 알파의 글" },
      { id: "2", ts: "2026-09-26T11:00:00", date: "2026-09-26", room: "일일업무", author: "Bravo Lee", text: "브라보의 글" },
    ],
    todos: { T001: { id: "T001", title: "가상 리워드", board_status: "review", status: "open", kind: "decision", age_days: 29, stale: true } },
    reports: [{ id: "reports/_analysis/a.md", kind: "analysis", date: null, title: "가상 종합 분석" }],
    decisions: { source: "lark_daily_brief_20260927.md", items: ["1. 가상 결정"] },
    dashboards: { full: "dashboard/lark_dashboard.html", share: "dashboard/lark_dashboard_share.html" },
    coverage: { raw_files: 1, messages: 2, live_messages: 0, unresolved_authors: [] },
  };
  writeFileSync(join(root, "out", "insights.json"), JSON.stringify(insights));
  writeFileSync(join(root, "out", "seed_state.json"), JSON.stringify({ owner_user_id: IDS.owner, owner_person: "Dylan" }));
  writeFileSync(join(root, "config", "office.config.json"), JSON.stringify({
    accounts: { [IDS.echo]: { person: "Echo Park", role: "admin" }, [IDS.bravo]: { person: "Bravo Lee", role: "member" } },
  }));
  server = createDashboard({ root, briefsDir: briefs, jwtSecret: SECRET, allowedHosts: new Set(["127.0.0.1", "localhost"]) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const cookieFor = (id, nickname = "x") => `token=${signJwt({ userId: IDS[id] ?? id, nickname }, SECRET)}`;

function get(path, { cookie, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let data = body;
        try { data = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, data, raw: body, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── 신원 ──
test("JWT: DeskRPG 형식만 통과 — 위조·만료·alg 바꿔치기 거절", () => {
  const good = signJwt({ userId: IDS.bravo, nickname: "b" }, SECRET);
  assert.equal(verifyJwt(good, SECRET).userId, IDS.bravo);
  assert.equal(verifyJwt(good, "other-secret-xxxxxxxxxxxxxxxx"), null);
  assert.equal(verifyJwt(signJwt({ userId: IDS.bravo }, SECRET, -10), SECRET), null);
  const [, p] = good.split(".");
  const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${p}.`;
  assert.equal(verifyJwt(none, SECRET), null);
  const hs = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const forged = `${hs}.${Buffer.from(JSON.stringify({ userId: IDS.owner, exp: 9e9 })).toString("base64url")}`;
  assert.equal(verifyJwt(`${forged}.${createHmac("sha256", "guess").update(forged).digest("base64url")}`, SECRET), null);
});

test("권한은 관리자 연결로만 — 닉네임 'Echo Park' 로 가입해도 아무것도 못 본다", async () => {
  assert.equal(identityOf(IDS.stranger, { accounts: {}, owner: null }), null);
  const r = await get("/api/me", { cookie: cookieFor("stranger", "Echo Park") });
  assert.deepEqual([r.data.signed_in, r.data.linked, r.data.role], [true, false, null]);
  assert.equal((await get("/api/team", { cookie: cookieFor("stranger", "Echo Park") })).status, 403);
  assert.equal((await get("/api/me", { cookie: cookieFor("owner") })).data.role, "admin"); // 사무실 소유자 = Dylan
  assert.ok(canSeePerson({ person: "Bravo Lee", role: "member" }, "Bravo Lee"));
  assert.ok(!canSeePerson({ person: "Bravo Lee", role: "member" }, "Alpha Kim"));
});

test("로그인 없으면 401, 다른 Host 는 403 (DNS 리바인딩)", async () => {
  assert.equal((await get("/api/team")).status, 401);
  assert.equal((await get("/api/me", { host: "evil.example:3302" })).status, 403);
  assert.equal((await get("/", {})).status, 200);
});

// ── 팀원 ──
test("팀원: 자기 것과 팀 현황만 — 남의 원문·L3·관리자 탭은 서버가 주지 않는다", async () => {
  const c = cookieFor("bravo");
  const me = await get("/api/person?name=Bravo%20Lee", { cookie: c });
  assert.equal(me.status, 200);
  assert.equal(me.data.local_layers, undefined);
  assert.deepEqual(me.data.messages.map((m) => m.author), ["Bravo Lee"]);
  assert.equal((await get("/api/person?name=Alpha%20Kim", { cookie: c })).status, 403);
  const search = await get("/api/search?q=ALPHA-PRIVATE&person=Alpha%20Kim", { cookie: c });
  assert.deepEqual(search.data.messages, []); // 남의 글은 검색으로도 안 나온다
  assert.equal((await get("/api/team", { cookie: c })).status, 200);
  for (const p of ["/api/problems", "/api/rooms", "/api/room?name=일일업무", "/api/reports", "/api/report?id=reports/_analysis/a.md"])
    assert.equal((await get(encodeURI(p), { cookie: c })).status, 403, p);
  const dash = await get("/view/dashboard?kind=full", { cookie: c });
  assert.match(dash.raw, /SHARE-DASHBOARD/); // 전체판을 요청해도 공유판
  assert.match(dash.headers["content-security-policy"], /^sandbox/);
});

// ── 관리자 ──
test("관리자(Echo Park): 전부 — 사람별·L3·방 원문·리포트·전체판", async () => {
  const c = cookieFor("echo");
  const alpha = await get("/api/person?name=Alpha%20Kim", { cookie: c });
  assert.deepEqual(alpha.data.local_layers, { L3_성격추론: ["ALPHA-L3-SECRET"] });
  const problems = await get("/api/problems", { cookie: c });
  assert.deepEqual(problems.data.blocked.map((b) => b.name), ["Alpha Kim"]);
  assert.equal((await get(encodeURI("/api/room?name=일일업무"), { cookie: c })).data.messages.length, 2);
  assert.match((await get("/api/report?id=reports/_analysis/a.md", { cookie: c })).data.text, /가상 종합 분석/);
  assert.match((await get("/view/dashboard?kind=full", { cookie: c })).raw, /FULL-DASHBOARD/);
});

test("리포트는 색인에 있는 briefs 안의 파일만 — 경로 조작 404", async () => {
  const c = cookieFor("owner");
  for (const id of ["../secret.md", "/etc/passwd", "reports/../../secret.md"])
    assert.equal((await get(`/api/report?id=${encodeURIComponent(id)}`, { cookie: c })).status, 404, id);
});

test("화면은 원문을 HTML 로 해석하지 않는다", () => {
  const html = renderDashboardPage();
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html));
  assert.ok(!/<script src=|<link [^>]*href="http/.test(html));
});

// ── 1:1 대화 ──
test("1:1 대화: 본인·관리자에게만 개인 답, 방·남에게는 공용 답", async () => {
  const { readFileSync } = await import("node:fs");
  const insights = JSON.parse(readFileSync(join(root, "out", "insights.json"), "utf8"));
  const identity = (id) => identityOf(id, {
    accounts: { [IDS.bravo]: { person: "Bravo Lee", role: "member" }, [IDS.echo]: { person: "Echo Park", role: "admin" } },
    owner: { user_id: IDS.owner, person: "Dylan" },
  });
  const alpha = office.members.find((m) => m.display_name === "Alpha Kim");
  const syn = office.members.find((m) => m.kind === "analyst");
  const ask = (member, key) => personalReply({ member, sessionKey: key, insights, office, identity, dashboardUrl: "http://x:3302" });
  assert.deepEqual(askerOf(`npc-9-dm-${IDS.bravo}`), { kind: "dm", userId: IDS.bravo });
  assert.equal(askerOf("npc-9-room-abc").kind, "room");
  assert.equal(ask(alpha, `npc-9-dm-${IDS.bravo}`), null); // 브라보가 알파에게 → 공용 답
  assert.equal(ask(alpha, "npc-9-room-abc"), null); // 방 → 공용 답
  assert.match(ask(alpha, `npc-9-dm-${IDS.echo}`), /관리자 보기[\s\S]*가상 막힘/);
  assert.match(ask(syn, `npc-9-dm-${IDS.owner}`), /오늘 결정할 것[\s\S]*1\. 가상 결정[\s\S]*Alpha Kim/);
  const bravoToSyn = ask(syn, `npc-9-dm-${IDS.bravo}`);
  assert.match(bravoToSyn, /Bravo Lee님의 요즘 일/);
  assert.ok(!/가상 결정|Alpha Kim/.test(bravoToSyn)); // 팀원에게 Syn 은 관리자 결정·남의 막힘을 말하지 않는다
});
