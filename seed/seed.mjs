#!/usr/bin/env node
// office.json → DeskRPG 사무실. 멱등이다 — 몇 번 돌려도 같은 사무실이 된다.
//
//   1. 사무실 소유자 계정 로그인(없으면 가입) · 내 아바타
//   2. famigo Lark 게이트웨이 등록
//   3. 구성원마다 Hermes 프로필 등록 → DeskRPG 가 NPC 로 고용·착석시킨다
//   4. 사무실(채널) 생성 — 기본 보드 = Lark To-do 장부
//   5. 프로젝트 "캠페인 파이프라인" — 두 번째 보드 = 방 접두사 기준 캠페인 상태
//
// 사용:
//   FAMIGO_GATEWAY_TOKEN=... FAMIGO_DESK_PASSWORD=... \
//   node seed/seed.mjs --app http://127.0.0.1:3000 --gateway http://127.0.0.1:8642 --office out/office.json

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { OFFICE_LOOKS, OFFICE_LOOK_IDS } from "./looks.mjs";

export const PIPELINE_PROJECT = "캠페인 파이프라인";
export const GATEWAY_NAME = "Famigo Lark";

export function createApi(appBaseUrl, fetchImpl = globalThis.fetch) {
  const base = new URL(appBaseUrl);
  let cookie = null;
  async function send(method, path, body) {
    const res = await fetchImpl(new URL(path, base), {
      method,
      redirect: "manual",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    const next = set.map((c) => c.split(";", 1)[0]).find((c) => c.startsWith("token="));
    if (next) cookie = next;
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  }
  return {
    send,
    async request(method, path, body) {
      const r = await send(method, path, body);
      if (!r.ok) {
        const code = r.data?.errorCode ?? r.data?.error ?? "";
        throw new Error(`${method} ${path} → ${r.status} ${code}`);
      }
      return r.data;
    },
  };
}

/** 구성원 → 외형. 설정에 있으면 그것, 없으면 이름 해시로 고정 배정(겹치지 않게). */
export function assignLooks(members) {
  const used = new Set(members.map((m) => m.look).filter(Boolean));
  const free = OFFICE_LOOK_IDS.filter((id) => !used.has(id));
  return members.map((m) => {
    if (m.look && OFFICE_LOOK_IDS.includes(m.look)) return { ...m, look: m.look };
    const h = parseInt(createHash("sha1").update(m.key).digest("hex").slice(0, 8), 16);
    const pool = free.length ? free : OFFICE_LOOK_IDS;
    const look = pool[h % pool.length];
    free.splice(free.indexOf(look), 1);
    return { ...m, look };
  });
}

/** DeskRPG officeLookAppearance(id) 와 같은 정본 두 키. */
export function appearance(lookId) {
  const look = OFFICE_LOOKS.find((l) => l.id === lookId);
  if (!look) throw new Error(`모르는 오피스 룩: ${lookId}`);
  return { officeLookId: look.id, bodyType: look.bodyType };
}

/** 반출 게이트가 이름 키를 지웠거나 스키마가 다르면 여기서 이유를 말하고 멈춘다. */
export function validateOffice(office) {
  const problems = [];
  if (office?.schema !== 1) problems.push(`schema ${office?.schema} (1 이어야 함)`);
  if (!office?.org?.name || !office?.org?.environment) problems.push("org.name/org.environment 없음");
  const members = Array.isArray(office?.members) ? office.members : [];
  if (!members.length) problems.push("members 비어 있음");
  members.forEach((m, i) => {
    if (!m?.key || !/^[A-Za-z0-9._-]+$/.test(m.key)) problems.push(`members[${i}].key 없음/형식 오류`);
    if (!m?.display_name) problems.push(`members[${i}].display_name 없음 — 게이트가 이름 키를 지웠는지 확인`);
  });
  if (problems.length) throw new Error(`office.json 을 쓸 수 없다:\n  - ${problems.join("\n  - ")}`);
}

export async function seed({ api, office, gatewayUrl, gatewayToken, account, log = console.log }) {
  validateOffice(office);
  // 1. 계정
  const login = await api.send("POST", "/api/auth/login", { loginId: account.loginId, password: account.password });
  if (!login.ok) {
    await api.request("POST", "/api/auth/register", account);
    log(`계정 생성: ${account.loginId}`);
  }
  const { characters = [] } = await api.request("GET", "/api/characters");
  if (!characters.length) {
    await api.request("POST", "/api/characters", {
      name: account.nickname,
      appearance: appearance(OFFICE_LOOK_IDS[0]),
    });
    log(`내 아바타 생성: ${account.nickname}`);
  }

  // 2. 게이트웨이
  const { gateways = [] } = await api.request("GET", "/api/gateways");
  let gateway = gateways.find((g) => (g.displayName ?? g.display_name) === GATEWAY_NAME);
  if (!gateway) {
    ({ gateway } = await api.request("POST", "/api/gateways", {
      url: gatewayUrl,
      token: gatewayToken,
      displayName: GATEWAY_NAME,
    }));
    log(`게이트웨이 등록: ${gatewayUrl}`);
  }
  const gid = encodeURIComponent(gateway.id);

  // 3. 구성원 = 프로필 = NPC
  const { profiles = [] } = await api.request("GET", `/api/gateways/${gid}/profiles`);
  const byName = new Map(profiles.map((p) => [p.profileName ?? p.profile_name, p]));
  for (const m of assignLooks(office.members)) {
    let p = byName.get(m.key);
    if (!p) {
      ({ profile: p } = await api.request("POST", `/api/gateways/${gid}/profiles`, {
        profileName: m.key,
        token: gatewayToken,
        displayName: m.display_name,
      }));
      log(`직원 등록: ${m.display_name} (${m.key})`);
    }
    await api.request("PATCH", `/api/gateways/${gid}/profiles/${encodeURIComponent(p.id)}`, {
      displayName: m.display_name,
      appearance: appearance(m.look),
    });
  }

  // 4. 사무실
  const channelName = office.org.name;
  const { channels = [] } = await api.request("GET", "/api/channels");
  let channel = channels.find((c) => c.name === channelName);
  if (!channel) {
    const { groups = [] } = await api.request("GET", "/api/groups");
    const group = groups.find((g) => g.isDefault || g.slug === "default") ?? groups[0];
    ({ channel } = await api.request("POST", "/api/channels", {
      name: channelName,
      description: "Lark 브리핑 데이터로 움직이는 사무실 — 보드는 Lark To-do 장부, 직원은 Lark 구성원",
      isPublic: false,
      password: account.password,
      environmentId: office.org.environment,
      groupId: group.id,
      gatewayConfig: { gatewayId: gateway.id },
    }));
    log(`사무실 생성: ${channelName} (${office.org.environment})`);
  }
  const cid = encodeURIComponent(channel.id);

  // 기본 보드(= 장부)를 먼저 잡는다 — 첫 보드가 이벤트 운반 보드가 된다.
  await api.request("GET", `/api/channels/${cid}/kanban/board`);

  // 5. 캠페인 파이프라인 보드
  const projects = await api.request("GET", `/api/channels/${cid}/projects`);
  const list = projects.projects ?? projects ?? [];
  if (!list.some((p) => p.name === PIPELINE_PROJECT)) {
    await api.request("POST", `/api/channels/${cid}/projects`, {
      name: PIPELINE_PROJECT,
      description: "Lark 방 이름 접두사(준비중·진행중·대기·종료·Cancel·완료)가 곧 상태다",
    });
    log(`프로젝트 생성: ${PIPELINE_PROJECT}`);
  }

  const roster = await api.request("GET", `/api/npcs?channelId=${cid}&roster=1`);
  return { channelId: channel.id, gatewayId: gateway.id, npcs: roster.npcs?.length ?? 0 };
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: "string", default: "http://127.0.0.1:3000" },
      gateway: { type: "string", default: "http://127.0.0.1:8642" },
      office: { type: "string", default: "out/office.json" },
      login: { type: "string", default: process.env.FAMIGO_DESK_LOGIN ?? "famigo-office" },
      nickname: { type: "string", default: process.env.FAMIGO_DESK_NICKNAME ?? "Dylan" },
    },
  });
  const token = process.env.FAMIGO_GATEWAY_TOKEN;
  const password = process.env.FAMIGO_DESK_PASSWORD;
  if (!token || token.length < 16) throw new Error("FAMIGO_GATEWAY_TOKEN(16자+) 이 필요하다");
  if (!password || password.length < 8) throw new Error("FAMIGO_DESK_PASSWORD(8자+) 가 필요하다");
  const office = JSON.parse(readFileSync(values.office, "utf8"));
  const result = await seed({
    api: createApi(values.app),
    office,
    gatewayUrl: values.gateway,
    gatewayToken: token,
    account: { loginId: values.login, nickname: values.nickname, password },
  });
  console.log(`✓ 사무실 ${result.channelId} · 착석 직원 ${result.npcs}명 · ${values.app}/channels`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
