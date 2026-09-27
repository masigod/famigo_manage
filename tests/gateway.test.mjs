// 게이트웨이·시더 회귀 테스트. 실행: node --test tests/
// DeskRPG 가 실제로 부르는 순서(probe → info → 보드 생성 → PATCH 이름 → 보드 읽기 → 대화)를 따른다.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../gateway/server.mjs";
import { assignLooks, appearance } from "../seed/seed.mjs";
import { OFFICE_LOOK_IDS } from "../seed/looks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-gateway-token-0123456789";
let dir, server, base;

async function call(method, path, { body, token = TOKEN, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, type: res.headers.get("content-type") ?? "", data };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "famigo-gw-"));
  const office = join(dir, "office.json");
  execFileSync("python3", [
    join(ROOT, "office/build_office.py"),
    "--data-dir",
    join(ROOT, "tests/fixtures/briefs/data"),
    "--config",
    "/nonexistent",
    "--out",
    office,
    "--now",
    "2026-09-27T08:00:00+09:00",
  ]);
  server = createGateway({ officePath: office, token: TOKEN, statePath: join(dir, "boards.json") });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("DeskRPG gateway-probe 가 Hermes API 서버로 판정한다", async () => {
  assert.equal((await call("GET", "/health", { token: null })).status, 200);
  const models = await call("GET", "/v1/models", { token: null });
  assert.equal(models.status, 401);
  assert.match(models.type, /json/);
});

test("automation 계약: version ≥ 0.6.0 + kanban·cron·events", async () => {
  const { data } = await call("GET", "/deskrpg/info");
  assert.equal(data.plugin, "deskrpg");
  for (const c of ["kanban", "cron", "events"]) assert.ok(data.capabilities.includes(c));
  assert.equal(data.kanban.dispatcher_present, false);
});

test("기본 보드 = 장부, 이름이 나중에 붙은 프로젝트 보드 = 파이프라인", async () => {
  assert.equal((await call("POST", "/deskrpg/kanban/boards", { body: { slug: "deskrpg-abc", name: "아울러스" } })).status, 201);
  // DeskRPG 프로젝트 보드: slug 로 먼저 만들고 PATCH 로 이름을 붙인다 (회귀: 생성 시점에 뷰를 굳히면 틀린다)
  await call("POST", "/deskrpg/kanban/boards", { body: { slug: "deskrpg-abc-1234", name: "deskrpg-abc-1234" } });
  await call("PATCH", "/deskrpg/kanban/boards/deskrpg-abc-1234", { body: { name: "캠페인 파이프라인" } });

  const ledger = (await call("GET", "/deskrpg/kanban/board?board=deskrpg-abc")).data;
  const review = ledger.columns.find((c) => c.name === "review").tasks;
  assert.deepEqual(review.map((t) => t.id), ["T001"]);
  assert.equal(review[0].assignee, "alpha-kim");
  assert.ok(!ledger.columns.some((c) => c.name === "archived")); // 기본은 보관함 숨김

  const pipe = (await call("GET", "/deskrpg/kanban/board?board=deskrpg-abc-1234")).data;
  const scheduled = pipe.columns.find((c) => c.name === "scheduled").tasks;
  assert.match(scheduled[0].title, /^🔴 가상 캠페인 B · 88일 조용$/);
});

test("쓰기는 전부 거절한다 — Lark 가 정본", async () => {
  const r = await call("POST", "/deskrpg/kanban/tasks?board=deskrpg-abc", { body: { title: "x" } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "read_only");
  assert.equal((await call("POST", "/deskrpg/kanban/tasks/T001/complete?board=deskrpg-abc", { body: {} })).status, 403);
});

test("Syn 은 방 대화에서 결정 대기를 경과일과 함께 말한다", async () => {
  const run = await call("POST", "/p/syn/v1/runs", {
    body: { input: "[최근 대화]\nDylan: @Syn 오늘 결정할 것\n[답하는 법]\n..." },
    headers: { "x-hermes-session-key": "ch-room-1" },
  });
  assert.equal(run.status, 202);
  const events = await call("GET", `/p/syn/v1/runs/${run.data.run_id}/events`);
  assert.match(events.data, /event: message\.completed/);
  assert.match(events.data, /결정 대기 1건/);
  assert.match(events.data, /T001 가상 리워드 금액 확정 — 29일째/);
});

test("회의(방이 아닌 run)는 SPEAK: 한 줄로 말한다", async () => {
  const run = await call("POST", "/p/bravo-lee/v1/runs", { body: { input: "안건" } });
  const events = await call("GET", `/p/bravo-lee/v1/runs/${run.data.run_id}/events`);
  const completed = /event: message\.completed\ndata: (.*)\n/.exec(events.data);
  assert.match(JSON.parse(completed[1]).content, /^SPEAK: Bravo Lee/);
});

test("모르는 프로필은 404", async () => {
  assert.equal((await call("POST", "/p/nobody/v1/runs", { body: {} })).status, 404);
});

test("외형: 설정값 우선, 나머지는 겹치지 않게 고정 배정", () => {
  const members = [{ key: "a", look: "office-seo" }, { key: "b" }, { key: "c" }, { key: "d", look: "bogus" }];
  const looks = assignLooks(members).map((m) => m.look);
  assert.equal(looks[0], "office-seo");
  assert.equal(new Set(looks).size, looks.length);
  for (const l of looks) assert.ok(OFFICE_LOOK_IDS.includes(l));
  assert.deepEqual(assignLooks(members), assignLooks(members)); // 결정적
  assert.deepEqual(appearance("office-seo"), { officeLookId: "office-seo", bodyType: "female" });
});

test("시더는 이름이 지워진 모델을 받으면 이유를 말하고 멈춘다", async () => {
  const { validateOffice } = await import("../seed/seed.mjs");
  const office = { schema: 1, org: { name: "o", environment: "trading" }, members: [{ key: "a" }] };
  assert.throws(() => validateOffice(office), /display_name 없음 — 게이트가 이름 키를 지웠는지/);
  assert.doesNotThrow(() => validateOffice({ ...office, members: [{ key: "a", display_name: "A" }] }));
});
