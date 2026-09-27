// Famigo Office 관리자 웹 — 퇴장·복귀, 표시 이름, 직무·팀, 외형을 웹에서 정한다.
//
// 설정의 정본은 config/office.config.json 이다(로컬 전용, gitignore). 관리자 웹은 그 파일을
// 고치고, build → seed 를 돌려 사무실에 바로 반영한다. Lark 는 건드리지 않는다.
//
// 보안: 127.0.0.1 에만 바인딩 · HTTP Basic(admin / FAMIGO_DESK_PASSWORD) ·
//       쓰기는 같은 출처(Origin)와 X-Famigo-Admin 헤더가 있어야 받는다(다른 사이트의 CSRF 차단).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
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

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
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
    for (const field of ["display_name", "role", "team", "look"]) {
      if (!(field in change)) continue;
      const v = typeof change[field] === "string" ? change[field].trim() : "";
      if (field === "look" && v && !OFFICE_LOOKS.some((l) => l.id === v)) throw new Error(`모르는 외형: ${v}`);
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

/** 화면에 뿌릴 상태 — Lark 명단 기준, 퇴장시킨 사람도 목록에 남긴다(복귀할 수 있게). */
export function adminState({ roster, office, config, seedState }) {
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

/** 이 Mac 의 LAN 주소들 (IPv4, 내부망만). */
export function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/** 팀원 접속 안내 — LAN 주소로 사무실이 실제로 열려 있는지 짧게 찔러 본다. */
async function teamAccess(seedState, channelPassword, deskPort = 3000) {
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

export function createAdmin({ root, password, runSync, channelPassword = process.env.FAMIGO_CHANNEL_PASSWORD }) {
  if (!password || password.length < 8) throw new Error("관리자 비밀번호(FAMIGO_DESK_PASSWORD 8자+)가 필요하다");
  const paths = {
    config: join(root, "config", "office.config.json"),
    roster: join(root, "out", "lark_roster.json"),
    office: join(root, "out", "office.json"),
    seedState: join(root, "out", "seed_state.json"),
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

  const authorized = (req) => {
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Basic ")) return false;
    const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString().split(":");
    return user === "admin" && safeEqual(rest.join(":"), password);
  };

  const server = createServer((req, res) => {
    const handle = async () => {
      if (!authorized(req)) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Famigo Office Admin", charset="UTF-8"' });
        return res.end("인증이 필요합니다");
      }
      const url = new URL(req.url ?? "/", "http://admin.local");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, renderAdminPage(), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state") {
        const seedState = readJson(paths.seedState, null);
        return send(res, 200, {
          access: await teamAccess(seedState, channelPassword),
          ...adminState({
            roster: readJson(paths.roster, null),
            office: readJson(paths.office, null),
            config: readJson(paths.config, {}),
            seedState,
          }),
          sync: { running: sync.running, pending: sync.pending, lastExit: sync.lastExit, lastAt: sync.lastAt, log: sync.log },
        });
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

/** 운영: build → seed 를 순서대로. 명단 수집(roster)은 하루 두 번 예약 sync 가 한다. */
export function shellSync(root) {
  return (onOutput) =>
    new Promise((resolve) => {
      const run = (args, next) => {
        const p = spawn("bash", [join(root, "scripts", "office.sh"), ...args], { cwd: root, env: process.env });
        p.stdout.on("data", (d) => onOutput(String(d)));
        p.stderr.on("data", (d) => onOutput(String(d)));
        p.on("close", (code) => (code === 0 && next ? next() : resolve(code ?? 1)));
      };
      onOutput(`── 관리자 반영 ${new Date().toLocaleString("ko-KR")}\n`);
      run(["build"], () => run(["seed"], null));
    });
}
