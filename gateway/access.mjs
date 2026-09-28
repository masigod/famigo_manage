// 누가 무엇을 보는가 — 대시보드(dashboard/server.mjs)와 직원 1:1 대화(gateway/personal.mjs)가 같은 규칙을 쓴다.
//
// 정본(2026-09-28 Dylan 결정):
//   - 관리자(Dylan 과 Dylan 이 관리자 웹에서 지정한 사람): 전부 — 모든 사람·모든 방 원문·리포트·전체 대시보드·L2·L3.
//   - 팀원: 자기 것(자기가 쓴 글·일일보고·자기 담당) + 팀 공용 현황(반출 게이트를 통과한 office.json 과
//     공유판 대시보드). 다른 사람의 원문은 보지 않는다.
//   - 연결되지 않은 DeskRPG 계정: 아무것도 보지 않는다.
//
// 신원: DeskRPG 로그인 쿠키(`token`, HS256 JWT {userId, nickname})를 DeskRPG 와 같은 JWT 비밀로 검증한다.
// **닉네임으로 권한을 주지 않는다** — DeskRPG 는 누구나 아무 닉네임으로 가입할 수 있다. 계정 ↔ Lark 사람 연결은
// 관리자 웹(이 Mac 전용)에서만 정한다. 예외는 사무실 소유자 계정 하나(설치 스크립트가 만든 famigo-office)다.

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export const ROLES = ["admin", "member"];

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** HS256 JWT 검증. 서명·alg·만료가 맞으면 페이로드, 아니면 null. */
export function verifyJwt(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256") return null; // alg 바꿔치기(none·RS256) 거절
  const expected = Buffer.from(b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest()));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (typeof payload?.exp !== "number" || payload.exp <= now) return null;
  if (typeof payload.userId !== "string" || !payload.userId) return null;
  return { userId: payload.userId, nickname: typeof payload.nickname === "string" ? payload.nickname : "" };
}

/** 테스트·도구용 — DeskRPG signJWT 와 같은 모양. */
export function signJwt(payload, secret, ttlSeconds = 7 * 86400, now = Math.floor(Date.now() / 1000)) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${h}.${p}.${b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest())}`;
}

export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * DeskRPG userId → { person, role } | null.
 * accounts: config.accounts ({userId: {person, role}}), owner: seed_state 의 {user_id, person}.
 */
export function identityOf(userId, { accounts = {}, owner = null } = {}) {
  const linked = accounts?.[userId];
  if (linked && typeof linked.person === "string" && ROLES.includes(linked.role)) {
    return { person: linked.person, role: linked.role };
  }
  if (owner?.user_id && owner.user_id === userId) return { person: owner.person, role: "admin" };
  return null;
}

export const isAdmin = (who) => who?.role === "admin";
export const canSeePerson = (who, person) => Boolean(who) && (isAdmin(who) || who.person === person);

/** 설정 파일 두 개(관리자 연결 · 시더 상태)를 mtime 이 바뀔 때만 다시 읽는다. */
export function createIdentitySource({ configPath, seedStatePath }) {
  let cache = null;
  let stamp = "";
  const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const read = (p) => {
    try {
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    } catch {
      return {};
    }
  };
  return (userId) => {
    const now = `${mtime(configPath)}:${mtime(seedStatePath)}`;
    if (now !== stamp) {
      const seed = read(seedStatePath);
      cache = {
        accounts: read(configPath).accounts ?? {},
        owner: seed.owner_user_id ? { user_id: seed.owner_user_id, person: seed.owner_person ?? "Dylan" } : null,
      };
      stamp = now;
    }
    return identityOf(userId, cache);
  };
}
