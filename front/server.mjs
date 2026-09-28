// Famigo Office 앞단 — 팀원이 들어오는 입구. 뒤의 사무실 엔진(DeskRPG)은 이 Mac 안(127.0.0.1)에 숨는다.
//
//   :PORT     화면(HTTP)      → 127.0.0.1:ENGINE_PORT     HTML 이면 이름·안내·기본 언어를 Famigo Office 로 입힌다
//   :PORT+1   실시간(Socket.io) → 127.0.0.1:ENGINE_PORT+1   브라우저는 '페이지 포트 + 1' 로 소켓을 붙는다(DeskRPG 클라이언트)
//
// 왜 앞단인가 (2026-09-28 Dylan: "로컬 서버를 이용한 독립된 서비스, 명칭·설정도 바꾸어야"):
//   - 이름을 바꾸되 DeskRPG 파일은 고치지 않는다. DeskRPG 는 Sustainable Use License 다 — 내부 업무용 수정은 되지만
//     라이선스·저작권 표시를 가리면 안 되고, 수정했다는 고지를 눈에 띄게 달아야 한다. 화면을 입히는 일은 이 Mac 에서
//     실행될 때만 일어나고, 저장소에는 DeskRPG 코드가 실리지 않는다.
//   - 엔진의 내부 RPC(`/_internal/*`, 소켓 포트에 함께 붙어 있다)는 LAN 에 열지 않는다 — 여기서 404.
//   - 입구가 하나라 설정(포트·언어·이름)이 한 곳에 모인다.

import { createServer, request } from "node:http";
import { connect } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRAND = "Famigo Office";
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = {
  "/__famigo/brand.js": ["application/javascript; charset=utf-8", "brand.js"],
  "/__famigo/brand.css": ["text/css; charset=utf-8", "brand.css"],
};
const LOCALE_COOKIE = "deskrpg-locale"; // DeskRPG src/lib/i18n/constants.ts

/** 엔진이 준 HTML 에 Famigo Office 를 입힌다. 라이선스·저작권 문구는 건드리지 않는다(브랜드 스크립트도 같은 규칙). */
export function brandHtml(html) {
  const head = `<link rel="stylesheet" href="/__famigo/brand.css"><script src="/__famigo/brand.js" defer></script>`;
  return html
    .replace(/<title>[^<]*<\/title>/i, `<title>${BRAND} — 아울러스 업무 사무실</title>`)
    .replace(/<html([^>]*)\blang="[^"]*"/i, '<html$1lang="ko"')
    .replace(/(<meta[^>]+(?:property|name)="(?:og:title|og:site_name|twitter:title|application-name|apple-mobile-web-app-title)"[^>]+content=")[^"]*(")/gi, `$1${BRAND}$2`)
    .replace(/<\/head>/i, `${head}</head>`);
}

const INVITE_COOKIE = "famigo-invite";
const INVITE_RE = /^\/channels\/join\/([A-Za-z0-9_-]{4,64})\/?$/;

function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * 초대 이어가기. DeskRPG 는 로그인하지 않은 사람이 초대 링크를 열면 /auth 로 보내면서 초대 코드를 잃는다
 * (307 → /auth, 돌아올 곳 없음 — 2026-09-28 실측). 그래서 가입한 팀원이 사무실 목록에 떨어져 채널 비밀번호
 * 단계 없이 혼자 남았다. 입구가 코드를 잠깐(1시간, HttpOnly) 기억했다가, 로그인·가입 뒤 사무실 목록에 닿으면
 * 초대 링크로 돌려보낸다. 사무실 참가 요청(POST /api/channels/<id>/join)이 성공하면 지운다 — 초대 페이지가
 * 캐릭터 만들기를 먼저 거치게 해도 초대를 잃지 않는다.
 * 반환: respond(바로 응답할 것) 또는 null(엔진으로 넘긴다).
 */
export const JOIN_API_RE = /^\/api\/channels\/[^/]+\/join\/?$/;
export const CLEAR_INVITE = `${INVITE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

export function inviteStep(req) {
  if (req.method !== "GET") return { respond: null, setCookie: null };
  const path = String(req.url ?? "").split("?")[0];
  const signedIn = Boolean(cookieValue(req.headers.cookie, "token"));
  const join = INVITE_RE.exec(path);
  if (join && !signedIn) {
    return {
      respond: { status: 307, headers: { Location: "/auth", "Set-Cookie": `${INVITE_COOKIE}=${join[1]}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax` } },
      setCookie: null,
    };
  }
  const pending = cookieValue(req.headers.cookie, INVITE_COOKIE);
  if (pending && signedIn && /^[A-Za-z0-9_-]{4,64}$/.test(pending) && (path === "/channels" || path === "/channels/" || path === "/")) {
    return { respond: { status: 307, headers: { Location: `/channels/join/${pending}` } }, setCookie: null };
  }
  return { respond: null, setCookie: null };
}

function hasCookie(header, name) {
  return String(header ?? "").split(";").some((p) => p.trim().startsWith(`${name}=`));
}

/** 요청 헤더 — 압축을 풀어 받는다(HTML 을 고쳐야 한다). 처음 온 사람은 한국어로. */
function upstreamHeaders(req) {
  const headers = { ...req.headers };
  delete headers["accept-encoding"];
  if (!hasCookie(headers.cookie, LOCALE_COOKIE)) headers.cookie = [headers.cookie, `${LOCALE_COOKIE}=ko`].filter(Boolean).join("; ");
  return headers;
}

/** engineSocketPort: 엔진의 실시간 소켓 포트 — DeskRPG 는 엔진 포트 + 1 을 쓴다. */
/**
 * signupClosed(): 가입을 닫았는가 — 관리자 웹이 config/office.config.json 의 "signup" 을 바꾼다. DeskRPG 에는 가입을
 * 막는 설정이 없어서 같은 네트워크의 누구나 계정을 만들 수 있다(사무실은 채널 비밀번호로 막혀 있어도).
 * 팀원이 다 가입한 뒤 닫는다. 닫혀 있으면 입구가 가입 요청을 거절한다 — 로그인은 그대로다.
 */
export function signupReader(configPath) {
  let stamp = -1;
  let closed = false;
  return () => {
    try {
      const m = existsSync(configPath) ? statSync(configPath).mtimeMs : 0;
      if (m !== stamp) {
        closed = m ? JSON.parse(readFileSync(configPath, "utf8")).signup === "closed" : false;
        stamp = m;
      }
    } catch {
      closed = true; // 설정을 못 읽으면 닫힌 쪽으로 — 실패하면 안전하게
    }
    return closed;
  };
}

export function createFront({ engineHost = "127.0.0.1", enginePort, engineSocketPort = enginePort + 1, licensePath = null, signupClosed = () => false }) {
  const assets = Object.fromEntries(Object.entries(ASSETS).map(([p, [type, file]]) => [p, { type, body: readFileSync(join(HERE, file)) }]));

  const web = createServer((req, res) => {
    if (req.url?.split("?")[0] === "/__famigo/license") {
      // 원본 라이선스 전문 — 받는 사람 누구나 이 조건을 받아야 한다(Sustainable Use License · Notices).
      const text = licensePath && existsSync(licensePath) ? readFileSync(licensePath, "utf8") : "DeskRPG LICENSE.md 를 찾지 못했습니다.";
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(`${BRAND} 는 Dante Labs 의 DeskRPG 를 수정해 사용합니다. 아래는 원본 라이선스 전문입니다.\n\n${text}`);
    }
    if (req.method === "POST" && req.url?.split("?")[0] === "/api/auth/register" && signupClosed()) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ errorCode: "registration_closed", error: "가입이 닫혀 있습니다. 관리자에게 문의하세요." }));
    }
    const invite = inviteStep(req);
    if (invite.respond) {
      res.writeHead(invite.respond.status, invite.respond.headers);
      return res.end();
    }
    const asset = assets[req.url?.split("?")[0]];
    if (asset) {
      res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
      return res.end(asset.body);
    }
    const up = request({ host: engineHost, port: enginePort, method: req.method, path: req.url, headers: upstreamHeaders(req) }, (upRes) => {
      const headers = { ...upRes.headers };
      const extra = [];
      if (!hasCookie(req.headers.cookie, LOCALE_COOKIE)) extra.push(`${LOCALE_COOKIE}=ko; Path=/; Max-Age=31536000; SameSite=Lax`);
      if (invite.setCookie) extra.push(invite.setCookie);
      // 참가 성공 — 기억해 둔 초대를 지운다(다시 돌려보내지 않게).
      if (req.method === "POST" && JOIN_API_RE.test(String(req.url ?? "").split("?")[0]) && (upRes.statusCode ?? 500) < 300 && cookieValue(req.headers.cookie, INVITE_COOKIE))
        extra.push(CLEAR_INVITE);
      if (extra.length) headers["set-cookie"] = [].concat(headers["set-cookie"] ?? [], extra);
      if (!/text\/html/i.test(String(headers["content-type"] ?? ""))) {
        res.writeHead(upRes.statusCode ?? 502, headers);
        return upRes.pipe(res);
      }
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        const body = Buffer.from(brandHtml(Buffer.concat(chunks).toString("utf8")), "utf8");
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        headers["content-length"] = String(body.length);
        res.writeHead(upRes.statusCode ?? 502, headers);
        res.end(body);
      });
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`${BRAND} 사무실 엔진이 아직 준비되지 않았습니다. 잠시 뒤 새로고침하세요.`);
    });
    req.pipe(up);
  });

  // 실시간 소켓 — 폴링(HTTP)과 웹소켓 업그레이드를 그대로 잇는다. 내부 RPC 는 막는다.
  const socketPort = engineSocketPort;
  const internal = (url) => String(url ?? "").startsWith("/_internal");
  const realtime = createServer((req, res) => {
    if (internal(req.url)) {
      res.writeHead(404);
      return res.end();
    }
    const up = request({ host: engineHost, port: socketPort, method: req.method, path: req.url, headers: req.headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  realtime.on("upgrade", (req, socket, head) => {
    if (internal(req.url)) return socket.destroy();
    const up = connect(socketPort, engineHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    // 한쪽이 닫히면 다른 쪽도 닫는다 — 반쯤 열린 연결이 서버에 쌓이지 않게.
    const close = () => {
      socket.destroy();
      up.destroy();
    };
    for (const s of [up, socket]) {
      s.on("error", close);
      s.on("close", close);
    }
  });

  return { web, realtime };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
  const port = Number(args.port ?? 3300);
  const host = args.host ?? "127.0.0.1";
  const { web, realtime } = createFront({
    enginePort: Number(args["engine-port"] ?? 3310),
    licensePath: args.deskrpg ? join(args.deskrpg, "LICENSE.md") : null,
    signupClosed: signupReader(join(HERE, "..", "config", "office.config.json")),
  });
  web.listen(port, host, () => console.log(`[famigo-front] ${BRAND} http://${host}:${port} → 엔진 127.0.0.1:${args["engine-port"] ?? 3310}`));
  realtime.listen(port + 1, host, () => console.log(`[famigo-front] 실시간 ${host}:${port + 1} → 127.0.0.1:${Number(args["engine-port"] ?? 3310) + 1}`));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
