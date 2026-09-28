// 외부 연결 차단기 — FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다(2026-09-28 Dylan 결정).
//
// DeskRPG·게이트웨이 프로세스에 NODE_OPTIONS=--require 로 먼저 올라가, **모든 TCP 연결**(http·https·fetch/undici·
// socket.io·tls)이 지나는 net.Socket.prototype.connect 에서 목적지를 검사한다. 이 Mac 자신이 아니면
// DNS 조회도 하기 전에 거절한다 — 호스트 이름조차 바깥 DNS 로 나가지 않는다.
//
// 왜 설정이 아니라 차단기인가: DeskRPG 에는 끌 수 없는 외부 호출이 있다(GitHub 별 개수·릴리스 확인,
// 채팅 링크 미리보기가 URL 을 서버에서 가져온다). 파일을 고치면 버전을 올릴 때마다 되살아나고, 새 버전이
// 새 호출을 더하면 모른다. 차단기는 코드가 무엇을 하든 목적지로 막는다.
//
// 허용: 루프백(127.0.0.0/8 · ::1 · localhost) · 0.0.0.0(자기 자신) · 이 Mac 의 인터페이스 IP
//       · FAMIGO_EGRESS_ALLOW 에 적은 호스트(쉼표). 유닉스 소켓(path)은 파일이라 허용.
// 로그: 막힐 때마다 stderr 에 "[egress-guard] 차단: host:port" (같은 목적지는 한 번만).

"use strict";

const net = require("node:net");
const os = require("node:os");

const extra = String(process.env.FAMIGO_EGRESS_ALLOW || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) out.add(i.address.toLowerCase());
  return out;
}
let own = ownAddresses();
let ownAt = Date.now();

function isAllowed(host) {
  const h = String(host || "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::" || h === "::1") return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\./.test(h)) return true;
  if (extra.includes(h)) return true;
  if (Date.now() - ownAt > 60_000) {
    own = ownAddresses(); // 와이파이가 바뀌어 IP 가 바뀌어도 따라간다
    ownAt = Date.now();
  }
  return own.has(h) || own.has(h.replace(/^::ffff:/, ""));
}

const reported = new Set();
function report(host, port) {
  const key = `${host}:${port}`;
  if (reported.has(key)) return;
  reported.add(key);
  process.stderr.write(`[egress-guard] 차단: ${key} (FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다)\n`);
}

/** connect 인자(여러 모양)에서 목적지를 뽑는다. path 면 유닉스 소켓. */
function target(args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0]; // 내부 normalized args 배열 형태
  if (a && typeof a === "object") return { path: a.path, host: a.host, port: a.port };
  if (typeof a === "string" && !/^\d+$/.test(a)) return { path: a };
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: a };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const t = target(args);
  if (!t.path && !isAllowed(t.host)) {
    report(t.host, t.port);
    const err = Object.assign(new Error(`egress blocked: ${t.host}:${t.port}`), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return originalConnect.apply(this, args);
};

module.exports = { isAllowed };
