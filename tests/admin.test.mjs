// 관리자 웹 회귀 테스트. 실행: node --test tests/*.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAccountChange, applyMemberChange, adminState, createAdmin, isLoopbackHost } from "../admin/server.mjs";
import { renderAdminPage } from "../admin/page.mjs";

let root, server, base, syncCalls;
const auth = {}; // 로그인 없음 — 이 Mac 전용(루프백 바인딩 + Host 검사)

before(async () => {
  root = mkdtempSync(join(tmpdir(), "famigo-admin-"));
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "out"));
  writeFileSync(
    join(root, "out", "lark_roster.json"),
    JSON.stringify({ generated_at: "2026-09-28T01:00:00+09:00", members: [{ name: "Alpha" }, { name: "help", rooms: ["a"] }] }),
  );
  writeFileSync(join(root, "out", "seed_state.json"), JSON.stringify({ departed: [{ key: "gone", display_name: "Gone" }] }));
  syncCalls = 0;
  server = createAdmin({
    root,
    listDeskUsers: () => ({ users: [{ id: "00000000-0000-4000-8000-00000000000d", loginId: "echo", nickname: "Echo Park" }], error: null }),
    runSync: async (out) => {
      syncCalls += 1;
      out("ok\n");
      return 0;
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

function getWithHost(path, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, path, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

test("로그인 없이 이 Mac 에서는 열린다", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/api/state")).status, 200);
  assert.equal(await getWithHost("/api/state", `localhost:${server.address().port}`), 200);
});

test("DNS 리바인딩: Host 가 루프백 이름이 아니면 403", async () => {
  assert.equal(await getWithHost("/api/state", "evil.example:3101"), 403);
  assert.equal(await getWithHost("/", "192.168.0.179:3101"), 403);
  assert.ok(isLoopbackHost("127.0.0.1:3101") && isLoopbackHost("[::1]:3101") && isLoopbackHost("LOCALHOST"));
  assert.ok(!isLoopbackHost("127.0.0.1.evil.example") && !isLoopbackHost(undefined));
});

test("다른 사이트에서 온 쓰기(CSRF)는 403", async () => {
  const body = JSON.stringify({ name: "help", action: "exclude" });
  const noHeader = await fetch(base + "/api/member", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body });
  assert.equal(noHeader.status, 403);
  const foreign = await fetch(base + "/api/member", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "X-Famigo-Admin": "1", Origin: "https://evil.example" },
    body,
  });
  assert.equal(foreign.status, 403);
});

test("퇴장 → 설정 파일에 기록 · 사무실 반영 1회 · 목록엔 퇴장으로 남는다", async () => {
  const r = await fetch(base + "/api/member", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "X-Famigo-Admin": "1", Origin: base },
    body: JSON.stringify({ name: "help", action: "exclude" }),
  });
  assert.equal(r.status, 202);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "config", "office.config.json"), "utf8")).exclude, ["help"]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(syncCalls, 1);
  const state = await (await fetch(base + "/api/state", { headers: auth })).json();
  assert.deepEqual(state.members.map((m) => [m.name, m.excluded]), [["Alpha", false], ["help", true]]);
  assert.equal(state.sync.lastExit, 0);
});

test("잘못된 외형·action 은 400, 설정은 그대로", async () => {
  const before = readFileSync(join(root, "config", "office.config.json"), "utf8");
  const r = await fetch(base + "/api/member", {
    method: "POST",
    headers: { ...auth, "X-Famigo-Admin": "1" },
    body: JSON.stringify({ name: "Alpha", action: "update", look: "office-nope" }),
  });
  assert.equal(r.status, 400);
  assert.equal(readFileSync(join(root, "config", "office.config.json"), "utf8"), before);
});

test("applyMemberChange: 수정·복귀·퇴장 후보 확정", () => {
  let c = applyMemberChange({}, { name: "Alpha", action: "update", display_name: " 알파 ", role: "운영", look: "office-seo" });
  assert.deepEqual(c.members.Alpha, { display_name: "알파", role: "운영", look: "office-seo" });
  c = applyMemberChange(c, { name: "Alpha", action: "update", role: "" }); // 비우면 지운다
  assert.deepEqual(c.members.Alpha, { display_name: "알파", look: "office-seo" });
  c = applyMemberChange(c, { name: "help", action: "exclude" });
  c = applyMemberChange(c, { name: "help", action: "include" });
  assert.deepEqual(c.exclude, []);
  c = applyMemberChange(c, { name: "Gone", action: "retire_departed", key: "gone" });
  assert.deepEqual(c.retire_keys, ["gone"]);
  assert.throws(() => applyMemberChange(c, { name: "x", action: "retire_departed", key: "../bad" }));
});

test("확정한 퇴장 후보는 후보 목록에서 빠진다", () => {
  const s = adminState({ roster: null, office: null, config: { retire_keys: ["gone"] }, seedState: { departed: [{ key: "gone", display_name: "Gone" }] } });
  assert.deepEqual(s.departed, []);
});

test("관리 화면은 이름을 innerHTML 로 넣지 않는다 (XSS)", () => {
  const html = renderAdminPage();
  assert.ok(!/innerHTML/.test(html));
  assert.ok(!/<script src=|<link [^>]*href="http/.test(html)); // 외부 리소스 0
});

test("계정 연결: DeskRPG 계정 ↔ Lark 사람 + 역할, 형식이 틀리면 400 · 저장해도 사무실 재배치는 없다", async () => {
  const uid = "00000000-0000-4000-8000-00000000000d";
  let c = applyAccountChange({}, { action: "link_account", userId: uid, person: "Echo Park", role: "admin" });
  assert.deepEqual(c.accounts[uid], { person: "Echo Park", role: "admin" });
  assert.throws(() => applyAccountChange(c, { action: "link_account", userId: uid, person: "Echo Park", role: "owner" }), /역할/);
  assert.throws(() => applyAccountChange(c, { action: "link_account", userId: "../x", person: "Echo Park", role: "admin" }), /userId/);
  assert.deepEqual(applyAccountChange(c, { action: "unlink_account", userId: uid }).accounts, {});

  const before = syncCalls;
  const r = await fetch(base + "/api/account", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Famigo-Admin": "1", Origin: base },
    body: JSON.stringify({ action: "link_account", userId: uid, person: "Echo Park", role: "admin" }),
  });
  assert.equal(r.status, 200);
  assert.equal(syncCalls, before);
  const state = await (await fetch(base + "/api/state")).json();
  assert.deepEqual(state.accounts.linked[uid], { person: "Echo Park", role: "admin" });
  assert.deepEqual(state.accounts.users.map((u) => u.nickname), ["Echo Park"]);
  const csrf = await fetch(base + "/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(csrf.status, 403);
});

test("팀원 초대 주소: 사설망 주소 우선, 링크 로컬(169.254)은 빼고", async () => {
  const { lanAddresses } = await import("../admin/server.mjs");
  const ifs = {
    bridge0: [{ family: "IPv4", internal: false, address: "169.254.63.22" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.0.179" }],
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
  };
  assert.deepEqual(lanAddresses(ifs), ["192.168.0.179"]);
});

test("가입 열기/닫기는 open·closed 만", () => {
  assert.equal(applyAccountChange({}, { action: "signup", value: "closed" }).signup, "closed");
  assert.throws(() => applyAccountChange({}, { action: "signup", value: "maybe" }), /signup/);
});
