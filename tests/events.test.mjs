// 게이트웨이 카드 이벤트 회귀 테스트 — DeskRPG automation-poller 가 기대하는 계약.
// 실행: node --test tests/*.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../gateway/server.mjs";
import { diffSnapshots, snapshotOf, createEventLog } from "../gateway/events.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-gateway-token-0123456789";
let dir, officePath, eventsPath, server, base;

async function get(path) {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return res.json();
}

async function start() {
  server = createGateway({ officePath, token: TOKEN, statePath: join(dir, "boards.json"), eventsPath });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

let bump = 0;
function rewriteOffice(mutate) {
  const office = JSON.parse(readFileSync(officePath, "utf8"));
  mutate(office);
  writeFileSync(officePath, JSON.stringify(office));
  const t = new Date(Date.now() + 1000 * ++bump); // mtime 이 반드시 바뀌게
  utimesSync(officePath, t, t);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "famigo-ev-"));
  officePath = join(dir, "office.json");
  eventsPath = join(dir, "gateway-events.json");
  execFileSync("python3", [
    join(ROOT, "office/build_office.py"),
    "--data-dir", join(ROOT, "tests/fixtures/briefs/data"),
    "--out", officePath,
    "--now", "2026-09-27T08:00:00+09:00",
  ]);
  await start();
  await fetch(base + "/deskrpg/kanban/boards", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "deskrpg-ledger", name: "아울러스" }),
  });
  await fetch(base + "/deskrpg/kanban/boards", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "deskrpg-pipe", name: "캠페인 파이프라인" }),
  });
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("diff: 상태 변화·생성·삭제, 경과일만 바뀐 것은 이벤트가 아니다", () => {
  const office = (ledger) => ({ boards: { ledger, pipeline: [] } });
  const a = snapshotOf(office([{ id: "T1", status: "review", title: "x", age_days: 3 }, { id: "T2", status: "todo", title: "y" }]));
  const b = snapshotOf(office([{ id: "T1", status: "done", title: "x", age_days: 4 }, { id: "T3", status: "todo", title: "z" }]));
  assert.deepEqual(
    diffSnapshots(a, b).map((e) => [e.kind, e.task_id]),
    [["task.status", "T1"], ["task.created", "T3"], ["task.deleted", "T2"]],
  );
  assert.deepEqual(diffSnapshots(a, b)[0].payload, { from: "review", to: "done", parent_count: 0, title: "x", assignee: null });
  const aged = snapshotOf(office([{ id: "T1", status: "review", title: "x", age_days: 9 }, { id: "T2", status: "todo", title: "y" }]));
  assert.deepEqual(diffSnapshots(a, aged), []);
});

test("커서 없는 첫 호출은 '지금' 토큰만 — 과거를 재생하지 않는다", async () => {
  const r = await get("/deskrpg/events?board=deskrpg-ledger");
  assert.deepEqual(r.events, []);
  assert.equal(r.has_more, false);
  assert.equal(typeof r.cursor, "string");
});

test("Lark 에서 장부 항목이 해결되면 장부 보드에 task.status review→done 이 온다", async () => {
  const { cursor } = await get("/deskrpg/events?board=deskrpg-ledger");
  const pipeCursor = (await get("/deskrpg/events?board=deskrpg-pipe")).cursor;
  rewriteOffice((o) => {
    o.boards.ledger.find((t) => t.id === "T001").status = "done";
  });
  const r = await get(`/deskrpg/events?board=deskrpg-ledger&cursor=${cursor}`);
  assert.equal(r.events.length, 1);
  const [e] = r.events;
  assert.equal(e.kind, "task.status");
  assert.equal(e.board, "deskrpg-ledger");
  assert.equal(e.task_id, "T001");
  assert.deepEqual([e.payload.from, e.payload.to], ["review", "done"]);
  assert.ok(Number.isInteger(e.ts) && e.ts < 1e11); // epoch 초
  // 파이프라인 보드는 장부 변화를 받지 않지만 커서는 앞으로 간다
  const p = await get(`/deskrpg/events?board=deskrpg-pipe&cursor=${pipeCursor}`);
  assert.deepEqual(p.events, []);
  assert.equal(p.cursor, r.cursor);
  // 같은 커서로 다시 물으면 비어 있다
  assert.deepEqual((await get(`/deskrpg/events?board=deskrpg-ledger&cursor=${r.cursor}`)).events, []);
});

test("방 이름 접두사가 바뀌면 파이프라인 보드에 상태 이벤트", async () => {
  const { cursor } = await get("/deskrpg/events?board=deskrpg-pipe");
  rewriteOffice((o) => {
    const b = o.boards.pipeline.find((p) => p.title === "가상 캠페인 B");
    b.stage = "진행중";
    b.status = "running";
  });
  const r = await get(`/deskrpg/events?board=deskrpg-pipe&cursor=${cursor}`);
  assert.deepEqual(r.events.map((e) => [e.kind, e.payload.from, e.payload.to]), [["task.status", "scheduled", "running"]]);
  assert.match(r.events[0].task_id, /^C-/);
});

test("게이트웨이를 재시작해도 커서가 이어지고, 모르는 커서는 '지금'으로", async () => {
  const { cursor } = await get("/deskrpg/events?board=deskrpg-ledger");
  server.close();
  await start();
  assert.deepEqual((await get(`/deskrpg/events?board=deskrpg-ledger&cursor=${cursor}`)).events, []);
  rewriteOffice((o) => {
    o.boards.ledger.find((t) => t.id === "T003").status = "blocked";
  });
  const r = await get(`/deskrpg/events?board=deskrpg-ledger&cursor=${cursor}`);
  assert.deepEqual(r.events.map((e) => e.task_id), ["T003"]);
  const future = await get(`/deskrpg/events?board=deskrpg-ledger&cursor=999999`);
  assert.deepEqual(future.events, []);
  assert.equal(future.cursor, r.cursor);
});

test("기록 파일은 상한을 넘지 않는다", () => {
  const log = createEventLog(null);
  const office = (n) => ({ boards: { ledger: Array.from({ length: n }, (_, i) => ({ id: `T${i}`, status: "todo", title: "t" })), pipeline: [] } });
  log.observe(office(0));
  log.observe(office(1200));
  assert.equal(log.seq, 1200);
  const all = log.poll({ cursor: "0", limit: 5000 });
  assert.equal(all.events.length, 1000);
  assert.equal(all.events[0].id, "famigo-201");
});

test("업무 카드: running 이 되면 run.started(3D '작업 중'), 새 막힘은 채팅 공지, 파이프라인은 run 이벤트 없음", () => {
  const office = (work, pipeline = []) => ({ boards: { ledger: [], pipeline, work } });
  const w = (id, status) => ({ id, status, title: id, assignee: "alpha-kim" });
  const kinds = (a, b) => diffSnapshots(snapshotOf(a), snapshotOf(b)).map((e) => [e.kind, e.task_id, e.payload.to ?? e.payload.assignee]);
  assert.deepEqual(kinds(office([]), office([w("W-1", "running"), w("W-2", "blocked")])), [
    ["task.created", "W-1", "alpha-kim"],
    ["task.run.started", "W-1", "alpha-kim"],
    ["task.created", "W-2", "alpha-kim"],
    ["task.status", "W-2", "blocked"],
  ]);
  assert.deepEqual(kinds(office([w("W-1", "todo")]), office([w("W-1", "running")])), [["task.status", "W-1", "running"], ["task.run.started", "W-1", "alpha-kim"]]);
  const p = (status) => ({ id: "oc", status, title: "캠페인", assignee: "alpha-kim", stage: "진행중" });
  assert.deepEqual(kinds(office([], [p("scheduled")]), office([], [p("running")])).map((e) => e[0]), ["task.status"]);
});
