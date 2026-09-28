// Famigo Office 앞단 회귀 테스트 — 가짜 엔진 앞에서 이름 입히기·언어·내부 RPC 차단·소켓 업그레이드.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandHtml, createFront } from "../front/server.mjs";

let engine, engineSocket, front, port, dir;
const upgraded = new Set();
const seen = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "famigo-front-"));
  writeFileSync(join(dir, "LICENSE.md"), "# License\nSustainable Use License (가상 사본)\n");
  engine = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, encoding: req.headers["accept-encoding"] });
    if (req.url === "/app.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end("console.log('DeskRPG 원본 그대로')");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "token=abc; Path=/" });
    res.end('<html lang="en"><head><title>DeskRPG — The Office Where AI Coworkers Work</title><meta property="og:title" content="DeskRPG for Hermes"></head><body>DeskRPG<footer>© Dante Labs · Sustainable Use License</footer></body></html>');
  });
  engineSocket = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`socket ${req.url}`);
  });
  engineSocket.on("upgrade", (req, socket) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(`echo:${d}`));
  });
  await new Promise((r) => engine.listen(0, "127.0.0.1", r));
  const enginePort = engine.address().port;
  await new Promise((r) => engineSocket.listen(0, "127.0.0.1", r)); // 병렬 테스트와 포트가 겹치지 않게 따로 고른다
  front = createFront({ enginePort, engineSocketPort: engineSocket.address().port, licensePath: join(dir, "LICENSE.md") });
  await new Promise((r) => front.web.listen(0, "127.0.0.1", r));
  await new Promise((r) => front.realtime.listen(0, "127.0.0.1", r));
  port = front.web.address().port;
});

after(() => {
  // fetch 의 keep-alive·업그레이드된 소켓이 남아 close() 가 끝나지 않는다 — 연결을 모두 끊고 닫는다.
  for (const s of upgraded) s.destroy();
  for (const s of [engine, engineSocket, front.web, front.realtime]) {
    s.closeAllConnections?.();
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("brandHtml: 제목·언어·메타·스크립트를 입히고 저작권 문구는 그대로", () => {
  const out = brandHtml('<html lang="en"><head><title>DeskRPG — x</title><meta property="og:title" content="DeskRPG"></head><body><footer>© Dante Labs</footer></body></html>');
  assert.match(out, /<title>Famigo Office — 아울러스 업무 사무실<\/title>/);
  assert.match(out, /lang="ko"/);
  assert.match(out, /content="Famigo Office"/);
  assert.match(out, /\/__famigo\/brand\.js/);
  assert.match(out, /© Dante Labs/);
});

test("화면: HTML 은 입히고, 처음 온 사람은 한국어, 엔진의 쿠키는 그대로 전달", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/auth`);
  const html = await r.text();
  assert.match(html, /<title>Famigo Office/);
  assert.match(html, /© Dante Labs · Sustainable Use License/); // 라이선스 표시는 손대지 않는다
  const cookies = r.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith("token=abc")));
  assert.ok(cookies.some((c) => c.startsWith("deskrpg-locale=ko")));
  const last = seen.at(-1);
  assert.match(last.cookie, /deskrpg-locale=ko/);
  assert.equal(last.encoding, undefined); // HTML 을 고치려고 압축 없이 받는다
});

test("화면: 언어를 이미 고른 사람은 건드리지 않고, HTML 이 아니면 원본 그대로", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/app.js`, { headers: { Cookie: "deskrpg-locale=en" } });
  assert.equal(await r.text(), "console.log('DeskRPG 원본 그대로')");
  assert.equal(seen.at(-1).cookie, "deskrpg-locale=en");
  assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith("deskrpg-locale")));
});

test("라이선스 전문과 브랜드 자원은 앞단이 준다", async () => {
  assert.match(await (await fetch(`http://127.0.0.1:${port}/__famigo/license`)).text(), /Sustainable Use License/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/__famigo/brand.js`)).status, 200);
});

test("실시간: 폴링은 잇고, 내부 RPC(/_internal)는 LAN 에 열지 않는다", async () => {
  const rt = front.realtime.address().port;
  assert.equal(await (await fetch(`http://127.0.0.1:${rt}/socket.io/?EIO=4`)).text(), "socket /socket.io/?EIO=4");
  assert.equal((await fetch(`http://127.0.0.1:${rt}/_internal/emit`, { method: "POST", body: "{}" })).status, 404);
});

test("실시간: 웹소켓 업그레이드를 엔진까지 그대로 잇는다", async () => {
  const rt = front.realtime.address().port;
  const reply = await new Promise((resolve, reject) => {
    const s = connect(rt, "127.0.0.1", () => {
      s.write("GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("101") && !buf.includes("echo")) s.write("ping");
      if (buf.includes("echo:ping")) {
        s.destroy();
        resolve(buf);
      }
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("timeout " + buf)), 3000);
  });
  assert.match(reply, /101 Switching Protocols[\s\S]*echo:ping/);
});

test("가입 닫기: 닫으면 가입 요청만 거절하고 로그인은 그대로", async () => {
  const { signupReader } = await import("../front/server.mjs");
  const cfg = join(dir, "office.config.json");
  const closed = signupReader(cfg);
  assert.equal(closed(), false); // 설정 없음 = 열림
  writeFileSync(cfg, JSON.stringify({ signup: "closed" }));
  assert.equal(closed(), true);
  const gated = createFront({ enginePort: engine.address().port, signupClosed: () => true });
  await new Promise((r) => gated.web.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${gated.web.address().port}`;
  const reg = await fetch(`${base}/api/auth/register`, { method: "POST", body: "{}" });
  assert.equal(reg.status, 403);
  assert.equal((await reg.json()).errorCode, "registration_closed");
  assert.equal((await fetch(`${base}/api/auth/login`, { method: "POST", body: "{}" })).status, 200);
  gated.web.closeAllConnections();
  gated.web.close();
  gated.realtime.close();
});

test("초대 이어가기: 로그인 전 초대 링크 → 코드 기억 → 가입 뒤 사무실 목록에서 초대로 → 참가 성공하면 잊는다", async () => {
  const { inviteStep, JOIN_API_RE } = await import("../front/server.mjs");
  const req = (url, cookie = "", method = "GET") => ({ url, method, headers: { cookie } });
  // 1. 로그인 안 한 사람이 초대 링크를 연다 → /auth 로 보내며 코드를 기억
  const first = inviteStep(req("/channels/join/ABCD1234"));
  assert.equal(first.respond.status, 307);
  assert.equal(first.respond.headers.Location, "/auth");
  assert.match(first.respond.headers["Set-Cookie"], /^famigo-invite=ABCD1234; Path=\/; Max-Age=3600; HttpOnly/);
  // 2. 가입·로그인 뒤 사무실 목록으로 가면 초대 링크로 돌려보낸다
  assert.deepEqual(inviteStep(req("/channels", "token=x; famigo-invite=ABCD1234")).respond, { status: 307, headers: { Location: "/channels/join/ABCD1234" } });
  assert.equal(inviteStep(req("/", "token=x; famigo-invite=ABCD1234")).respond.headers.Location, "/channels/join/ABCD1234");
  // 3. 로그인하고 초대 페이지에 있으면 엔진으로 그대로(비밀번호 입력)
  assert.equal(inviteStep(req("/channels/join/ABCD1234", "token=x; famigo-invite=ABCD1234")).respond, null);
  // 캐릭터 만들기 같은 다른 화면은 방해하지 않는다
  assert.equal(inviteStep(req("/characters/new", "token=x; famigo-invite=ABCD1234")).respond, null);
  // 초대가 없으면 아무 일 없다 · 이상한 코드는 따르지 않는다
  assert.equal(inviteStep(req("/channels", "token=x")).respond, null);
  assert.equal(inviteStep(req("/channels", "token=x; famigo-invite=../evil")).respond, null);
  assert.ok(JOIN_API_RE.test("/api/channels/a8ac969a-4558/join"));
});

test("초대 이어가기: 참가 요청이 성공하면 기억한 초대를 지운다", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/channels/abc/join`, { method: "POST", headers: { Cookie: "token=x; famigo-invite=ABCD1234; deskrpg-locale=ko" }, body: "{}" });
  assert.ok(r.headers.getSetCookie().some((c) => c.startsWith("famigo-invite=; Path=/; Max-Age=0")));
  const other = await fetch(`http://127.0.0.1:${port}/api/other`, { method: "POST", headers: { Cookie: "token=x; famigo-invite=ABCD1234; deskrpg-locale=ko" }, body: "{}" });
  assert.ok(!other.headers.getSetCookie().some((c) => c.startsWith("famigo-invite=")));
});
