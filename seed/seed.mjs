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
//   node seed/seed.mjs --app http://127.0.0.1:3300 --gateway http://127.0.0.1:8642 --office out/office.json

import { readFileSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * 구성원 → 외형. 우선순위: 관리자 설정 > 지금 사무실에서의 외형(유지) > 새 사람만 자동 배정.
 * 자동 배정은 키 해시에서 시작해 비어 있는 외형을 차례로 찾는다 — 다른 사람의 설정이 바뀌어도
 * 이미 앉아 있는 사람의 외형은 흔들리지 않는다(회귀: 한 명을 바꾸면 전원이 다시 섞였다).
 */
export function assignLooks(members, current = new Map()) {
  const valid = (id) => OFFICE_LOOK_IDS.includes(id);
  const chosen = new Map();
  for (const m of members) if (m.look && valid(m.look)) chosen.set(m.key, m.look);
  for (const m of members) {
    const now = current.get(m.key);
    if (!chosen.has(m.key) && now && valid(now)) chosen.set(m.key, now);
  }
  const taken = new Set(chosen.values());
  for (const m of [...members].sort((a, b) => a.key.localeCompare(b.key))) {
    if (chosen.has(m.key)) continue;
    const start = parseInt(createHash("sha1").update(m.key).digest("hex").slice(0, 8), 16) % OFFICE_LOOK_IDS.length;
    let look = OFFICE_LOOK_IDS[start];
    for (let i = 0; i < OFFICE_LOOK_IDS.length; i += 1) {
      const candidate = OFFICE_LOOK_IDS[(start + i) % OFFICE_LOOK_IDS.length];
      if (!taken.has(candidate)) {
        look = candidate;
        break;
      }
    }
    chosen.set(m.key, look);
    taken.add(look);
  }
  return members.map((m) => ({ ...m, look: chosen.get(m.key) }));
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

/**
 * 퇴장은 사람이 정한다. 자동으로 지우는 것은 두 경우뿐이다:
 *   - 관리자 웹에서 퇴장시킨 사람(office.excluded_keys)
 *   - 플레이어 본인(아바타로 이미 사무실에 있다)
 * Lark 명단에서 사라진 사람은 지우지 않고 '퇴장 후보'로 남겨 관리자 웹에 보인다.
 */
export function classifyProfiles(profiles, keepKeys, excludedKeys, isPlayerProfile) {
  const retire = [];
  const departed = [];
  for (const p of profiles) {
    const key = p.profileName ?? p.profile_name;
    if (keepKeys.has(key)) continue;
    if (isPlayerProfile(p)) retire.push({ profile: p, why: "플레이어 본인" });
    else if (excludedKeys.has(key)) retire.push({ profile: p, why: "관리자 퇴장" });
    else departed.push(p);
  }
  return { retire, departed };
}

export async function seed({
  api,
  office,
  gatewayUrl,
  gatewayToken,
  account,
  log = console.log,
  statePath = null,
  channelPassword = account.password,
}) {
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
  const { profiles: listed } = await api.request("GET", `/api/gateways/${gid}/profiles`);
  const profiles = Array.isArray(listed) ? listed : [];
  const byName = new Map(profiles.map((p) => [p.profileName ?? p.profile_name, p]));
  // 플레이어 본인은 아바타로 이미 사무실에 있다 — NPC 로 한 번 더 두지 않는다.
  const isPlayer = (m) =>
    [m.display_name, ...(m.aliases ?? [])].some((n) => n?.toLowerCase() === account.nickname.toLowerCase());
  const members = office.members.filter((m) => m.kind !== "member" || !isPlayer(m));
  if (members.length < office.members.length) log(`플레이어 본인(${account.nickname})은 NPC 로 두지 않음`);
  const current = new Map(
    profiles.map((p) => [p.profileName ?? p.profile_name, (p.appearance ?? {}).officeLookId]).filter(([, id]) => id),
  );
  for (const m of assignLooks(members, current)) {
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

  // 3-1. 퇴장 — 이 게이트웨이의 프로필만 본다.
  const { retire, departed } = classifyProfiles(
    profiles,
    new Set(members.map((m) => m.key)),
    new Set(office.excluded_keys ?? []),
    (p) => (p.displayName ?? p.display_name ?? "").toLowerCase() === account.nickname.toLowerCase(),
  );
  for (const { profile: p, why } of retire) {
    await api.request("DELETE", `/api/gateways/${gid}/profiles/${encodeURIComponent(p.id)}`);
    log(`퇴장: ${p.displayName ?? p.profileName} (${why})`);
  }
  if (departed.length)
    log(`퇴장 후보 ${departed.length}명 (Lark 명단에 없음 — 관리자 웹에서 결정): ${departed.map((p) => p.displayName ?? p.profileName).join(", ")}`);

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
      password: channelPassword,
      environmentId: office.org.environment,
      groupId: group.id,
      gatewayConfig: { gatewayId: gateway.id },
    }));
    log(`사무실 생성: ${channelName} (${office.org.environment})`);
  }
  const cid = encodeURIComponent(channel.id);
  // 팀원이 들어올 때 쓰는 비밀번호. env 가 정본 — 매번 적용해 둘이 어긋나지 않게 한다.
  await api.request("PUT", `/api/channels/${cid}`, { password: channelPassword });
  const detail = await api.request("GET", `/api/channels/${cid}`);
  const inviteCode = detail.channel?.inviteCode ?? null;

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
  if (statePath) {
    const state = {
      updated: new Date().toISOString(),
      channel_id: channel.id,
      invite_code: inviteCode,
      departed: departed.map((p) => ({ key: p.profileName ?? p.profile_name, display_name: p.displayName ?? p.profileName })),
    };
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  }
  return { channelId: channel.id, gatewayId: gateway.id, npcs: roster.npcs?.length ?? 0, inviteCode };
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: "string", default: `http://127.0.0.1:${process.env.FAMIGO_DESK_PORT || 3300}` },
      gateway: { type: "string", default: "http://127.0.0.1:8642" },
      office: { type: "string", default: "out/office.json" },
      state: { type: "string", default: "out/seed_state.json" },
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
    // 옛 설치(env 에 채널 비밀번호 없음)는 소유자 비밀번호로 남는다 — install-mac.sh 를 다시 돌리면 분리된다.
    channelPassword: process.env.FAMIGO_CHANNEL_PASSWORD || password,
    statePath: values.state,
  });
  console.log(`✓ 사무실 ${result.channelId} · 착석 직원 ${result.npcs}명 · ${values.app}/channels`);
  if (result.inviteCode) console.log(`  초대 경로: /channels/join/${result.inviteCode} (채널 비밀번호 FAMIGO_CHANNEL_PASSWORD)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
