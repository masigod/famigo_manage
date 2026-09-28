// Famigo Office 관리자 웹 — 퇴장·복귀, 표시 이름, 직무·팀, 외형을 웹에서 정한다.
//
// 설정의 정본은 config/office.config.json 이다(로컬 전용, gitignore). 관리자 웹은 그 파일을
// 고치고, build → seed 를 돌려 사무실에 바로 반영한다. Lark 는 건드리지 않는다.
//
// 보안: 로그인은 두지 않는다 — 이 Mac 에서 Dylan 만 쓴다(2026-09-28 결정). 대신
//   - 127.0.0.1 에만 바인딩한다(LAN 에서 연결 불가).
//   - Host 헤더가 127.0.0.1·localhost·[::1] 이 아니면 거절한다. 로그인이 없으면 악성 페이지가 자기 도메인을
//     127.0.0.1 로 돌려(DNS 리바인딩) 브라우저로 이 API 를 부를 수 있는데, 그때 Host 는 그 도메인이다.
//   - 쓰기는 같은 출처(Origin)와 X-Famigo-Admin 헤더가 있어야 받는다(다른 사이트의 CSRF 차단).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import { ROLES } from "../gateway/access.mjs";
import { OFFICE_LOOKS } from "../seed/looks.mjs";
import { renderAdminPage } from "./page.mjs";

const readJson = (path, fallback) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};

function writeJsonAtomic(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** DNS 리바인딩 차단 — 이 Mac 의 루프백 이름으로 들어온 요청만 받는다. */
export function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host ?? ""));
}

/** config 를 한 사람 단위로 고친다. 순수 함수 — 테스트 대상. */
export function applyMemberChange(config, change) {
  const next = structuredClone(config ?? {});
  next.members ??= {};
  next.exclude ??= [];
  next.retire_keys ??= [];
  const { name, action } = change;
  if (typeof name !== "string" || !name.trim()) throw new Error("name 이 필요하다");
  const drop = (list, v) => list.filter((x) => x !== v);
  if (action === "exclude") {
    if (!next.exclude.includes(name)) next.exclude.push(name);
  } else if (action === "include") {
    next.exclude = drop(next.exclude, name);
    if (next.members[name]?.include === false) delete next.members[name].include;
  } else if (action === "update") {
    const m = { ...(next.members[name] ?? {}) };
    for (const field of ["display_name", "role", "team", "look", "body"]) {
      if (!(field in change)) continue;
      const v = typeof change[field] === "string" ? change[field].trim() : "";
      if (field === "look" && v && !OFFICE_LOOKS.some((l) => l.id === v)) throw new Error(`모르는 외형: ${v}`);
      // 몸형은 사람이 정한다 — 대화에는 성별 근거가 없었다(office/persona.py). 비우면 '지금 외형 유지'.
      if (field === "body" && v && !["female", "male"].includes(v)) throw new Error(`몸형은 female·male 중 하나: ${v}`);
      if (v) m[field] = v;
      else delete m[field];
    }
    if (Object.keys(m).length) next.members[name] = m;
    else delete next.members[name];
  } else if (action === "retire_departed") {
    const key = change.key;
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]+$/.test(key)) throw new Error("key 형식 오류");
    if (!next.retire_keys.includes(key)) next.retire_keys.push(key);
  } else {
    throw new Error(`모르는 action: ${action}`);
  }
  return next;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 대시보드 계정 연결 — DeskRPG 계정(userId) ↔ Lark 사람 + 역할. 순수 함수 — 테스트 대상.
 * 권한은 이 연결로만 생긴다(닉네임으로 주지 않는다 — gateway/access.mjs).
 */
export function applyAccountChange(config, change) {
  const next = structuredClone(config ?? {});
  next.accounts ??= {};
  const { action, userId } = change;
  if (action === "signup") {
    // 가입 열기/닫기 — 입구(front/server.mjs)가 설정 파일을 보고 가입 요청을 막는다.
    if (!["open", "closed"].includes(change.value)) throw new Error("signup 은 open 또는 closed");
    next.signup = change.value;
    return next;
  }
  if (typeof userId !== "string" || !UUID_RE.test(userId)) throw new Error("userId 형식 오류");
  if (action === "link_account") {
    const person = typeof change.person === "string" ? change.person.trim() : "";
    if (!person || person.length > 100) throw new Error("Lark 사람을 고르세요");
    if (!ROLES.includes(change.role)) throw new Error("역할은 admin 또는 member");
    next.accounts[userId] = { person, role: change.role };
  } else if (action === "unlink_account") {
    delete next.accounts[userId];
  } else {
    throw new Error(`모르는 action: ${action}`);
  }
  return next;
}

/** DeskRPG 가입 계정 목록 — DB 를 읽기 전용으로 연다(DeskRPG 가 설치한 better-sqlite3). */
export function deskUserLister({
  dbPath = join(homedir(), ".deskrpg", "data", "deskrpg.db"),
  deskrpgDir = process.env.FAMIGO_DESKRPG_DIR,
} = {}) {
  return () => {
    if (!deskrpgDir || !existsSync(dbPath)) return { users: [], error: "DeskRPG DB 를 찾지 못했습니다" };
    try {
      const Database = createRequire(join(deskrpgDir, "package.json"))("better-sqlite3");
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const users = db.prepare("SELECT id, login_id AS loginId, nickname, created_at AS createdAt FROM users ORDER BY created_at").all();
        return { users, error: null };
      } finally {
        db.close();
      }
    } catch (e) {
      return { users: [], error: `DeskRPG 계정 목록을 읽지 못했습니다: ${e.message}` };
    }
  };
}

/** 화면에 뿌릴 상태 — Lark 명단 기준, 퇴장시킨 사람도 목록에 남긴다(복귀할 수 있게). */
export function adminState({ roster, office, config, seedState, persona = null }) {
  const cfg = config ?? {};
  const excluded = new Set(cfg.exclude ?? []);
  const byName = new Map((office?.members ?? []).filter((m) => m.kind === "member").map((m) => [m.aliases?.[0] ?? m.display_name, m]));
  for (const m of office?.members ?? []) for (const a of m.aliases ?? []) if (!byName.has(a)) byName.set(a, m);
  const names = roster?.members?.length
    ? roster.members.map((r) => ({ name: r.name, rooms: r.rooms?.length ?? 0 }))
    : (office?.members ?? []).filter((m) => m.kind === "member").map((m) => ({ name: m.display_name, rooms: m.rooms?.length ?? 0 }));
  for (const n of excluded) if (!names.some((x) => x.name === n)) names.push({ name: n, rooms: 0 });
  const members = names.map(({ name, rooms }) => {
    const m = byName.get(name);
    const c = cfg.members?.[name] ?? {};
    return {
      name,
      rooms,
      excluded: excluded.has(name) || c.include === false,
      display_name: c.display_name ?? "",
      role: c.role ?? "",
      team: c.team ?? "",
      look: c.look ?? "",
      body: c.body ?? "",
      // 말투·성향 분석(office/persona.py) — 외형을 '자동'으로 두면 이 결과가 쓰인다.
      persona: persona?.people?.[name] ?? null,
      last_active: m?.last_active ?? null,
      reports: m?.reports ?? null,
    };
  });
  const retired = new Set(cfg.retire_keys ?? []);
  return {
    office_generated_at: office?.generated_at ?? null,
    roster_generated_at: roster?.generated_at ?? null,
    members,
    departed: (seedState?.departed ?? []).filter((d) => !retired.has(d.key)),
    looks: OFFICE_LOOKS,
  };
}

/** 사설망(RFC 1918) 주소인가 — 팀원이 닿을 수 있는 주소. */
const isPrivateLan = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/**
 * 이 Mac 의 LAN 주소들 (IPv4). 사설망 주소를 앞에 둔다. 169.254.x.x(링크 로컬, 자동 할당)는 뺀다 —
 * 팀원이 닿을 수 없는데 인터페이스 순서상 먼저 나와 초대 주소로 잘못 보였다(2026-09-28 실측).
 */
export function lanAddresses(interfaces = networkInterfaces()) {
  const ips = Object.values(interfaces)
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254."))
    .map((i) => i.address);
  return [...ips.filter(isPrivateLan), ...ips.filter((ip) => !isPrivateLan(ip))];
}

/** 팀원 접속 안내 — LAN 주소로 사무실이 실제로 열려 있는지 짧게 찔러 본다. */
async function teamAccess(seedState, channelPassword, deskPort = Number(process.env.FAMIGO_DESK_PORT) || 3300) {
  const ip = lanAddresses()[0] ?? null;
  let lan = false;
  if (ip) {
    try {
      const r = await fetch(`http://${ip}:${deskPort}/auth`, { signal: AbortSignal.timeout(1200), redirect: "manual" });
      lan = r.status < 500;
    } catch {
      lan = false;
    }
  }
  return {
    lan,
    ip,
    office_url: ip ? `http://${ip}:${deskPort}` : null,
    invite_url: ip && seedState?.invite_code ? `http://${ip}:${deskPort}/channels/join/${seedState.invite_code}` : null,
    channel_password: channelPassword || null,
  };
}

export function createAdmin({ root, runSync, channelPassword = process.env.FAMIGO_CHANNEL_PASSWORD, listDeskUsers = deskUserLister() }) {
  const paths = {
    config: join(root, "config", "office.config.json"),
    roster: join(root, "out", "lark_roster.json"),
    office: join(root, "out", "office.json"),
    seedState: join(root, "out", "seed_state.json"),
    persona: join(root, "out", "persona.json"),
  };
  const sync = { running: false, pending: false, lastExit: null, lastAt: null, log: "" };

  const startSync = () => {
    if (sync.running) {
      sync.pending = true;
      return;
    }
    sync.running = true;
    sync.log = "";
    runSync((chunk) => {
      sync.log = (sync.log + chunk).slice(-6000);
    }).then((code) => {
      sync.running = false;
      sync.lastExit = code;
      sync.lastAt = new Date().toISOString();
      if (sync.pending) {
        sync.pending = false;
        startSync();
      }
    });
  };

  const send = (res, status, body, type = "application/json; charset=utf-8") => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const handle = async () => {
      if (!isLoopbackHost(req.headers.host))
        return send(res, 403, { error: "이 Mac 에서 http://127.0.0.1 로만 열 수 있습니다" });
      const url = new URL(req.url ?? "/", "http://admin.local");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, renderAdminPage(), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state") {
        const seedState = readJson(paths.seedState, null);
        const config = readJson(paths.config, {});
        const roster = readJson(paths.roster, null);
        const desk = listDeskUsers();
        return send(res, 200, {
          access: await teamAccess(seedState, channelPassword),
          accounts: {
            users: desk.users,
            error: desk.error,
            linked: config.accounts ?? {},
            owner_user_id: seedState?.owner_user_id ?? null,
            owner_person: seedState?.owner_person ?? null,
            persons: [...new Set([...(roster?.members ?? []).map((m) => m.name), ...Object.values(config.accounts ?? {}).map((a) => a.person)])].sort(),
            dashboard_url: process.env.FAMIGO_DASHBOARD_URL || null,
            signup: config.signup === "closed" ? "closed" : "open",
          },
          ...adminState({
            roster: readJson(paths.roster, null),
            office: readJson(paths.office, null),
            config: readJson(paths.config, {}),
            seedState,
            persona: readJson(paths.persona, null),
          }),
          sync: { running: sync.running, pending: sync.pending, lastExit: sync.lastExit, lastAt: sync.lastAt, log: sync.log },
        });
      }
      if (req.method === "POST" && url.pathname === "/api/account") {
        const origin = req.headers.origin;
        if (req.headers["x-famigo-admin"] !== "1" || (origin && origin !== `http://${req.headers.host}`))
          return send(res, 403, { error: "같은 출처의 관리자 화면에서만 바꿀 수 있습니다" });
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try {
          const change = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          writeJsonAtomic(paths.config, applyAccountChange(readJson(paths.config, {}), change));
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
        // 대시보드·1:1 대화는 설정 파일을 mtime 으로 다시 읽는다 — 사무실 재배치는 필요 없다.
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && (url.pathname === "/api/member" || url.pathname === "/api/sync")) {
        const origin = req.headers.origin;
        if (req.headers["x-famigo-admin"] !== "1" || (origin && origin !== `http://${req.headers.host}`))
          return send(res, 403, { error: "같은 출처의 관리자 화면에서만 바꿀 수 있습니다" });
        if (url.pathname === "/api/member") {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          let change;
          try {
            change = JSON.parse(Buffer.concat(chunks).toString() || "{}");
            writeJsonAtomic(paths.config, applyMemberChange(readJson(paths.config, {}), change));
          } catch (e) {
            return send(res, 400, { error: e.message });
          }
        }
        startSync();
        return send(res, 202, { queued: true });
      }
      return send(res, 404, { error: "not_found" });
    };
    handle().catch((e) => send(res, 500, { error: e.message }));
  });
  return server;
}

/**
 * 운영: build → seed 를 잠금 하나 안에서(`office.sh apply`). 실시간 데몬(lark_live.py)과 같은 잠금을 쓴다 —
 * 둘이 겹쳐 시더가 같은 프로필을 동시에 만드는 일이 없다. 명단 수집(roster)은 실시간 데몬이 한다.
 */
export function shellSync(root) {
  return (onOutput) =>
    new Promise((resolve) => {
      onOutput(`── 관리자 반영 ${new Date().toLocaleString("ko-KR")}\n`);
      const p = spawn("bash", [join(root, "scripts", "office.sh"), "apply"], { cwd: root, env: process.env });
      p.stdout.on("data", (d) => onOutput(String(d)));
      p.stderr.on("data", (d) => onOutput(String(d)));
      p.on("close", (code) => resolve(code ?? 1));
    });
}
