#!/usr/bin/env node
// famigo Lark 게이트웨이 — DeskRPG 에게는 Hermes 게이트웨이(+ deskrpg 플러그인)로 보이고,
// 실제로는 Lark 브리핑 데이터(office.json)를 읽기 전용으로 서빙한다.
//
// 왜 진짜 Hermes 가 아닌가:
//   - Lark 가 정본이다. 사무실에서 카드를 옮겨도 Lark 는 안 바뀐다 → 쓰기는 전부 거절한다.
//   - Hermes 카드는 만들어지는 순간 dispatch 로 에이전트가 일을 시작한다. 장부 항목이
//     에이전트 작업으로 바뀌면 안 된다.
//   - LLM 키도, 에이전트 실행 비용도 필요 없다.
//
// 사용:
//   FAMIGO_GATEWAY_TOKEN=$(openssl rand -hex 24) node gateway/server.mjs --office out/office.json
//
// 계약 근거: deskrpg src/lib/hermes/deskrpg-plugin-types.ts · gateway-probe.ts ·
//           scripts/readme-capture/mock-hermes.ts (플러그인 0.6.0+ automation 계약)

import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOfficeSource, renderBoard, cardsFor } from "./office-model.mjs";
import { composeReply } from "./replies.mjs";

export const PLUGIN_VERSION = "0.6.0";
const PIPELINE_RE = /파이프라인|pipeline/i;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function sse(res, eventName, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  // 줄 단위로 흘려 보낸다 — 사무실 UI 가 스트리밍 상태를 보여 준다.
  const chunks = text.split(/(?<=\n)/);
  for (const [i, delta] of chunks.entries()) {
    res.write(`event: ${eventName}.delta\ndata: ${JSON.stringify({ delta, seq: i + 1 })}\n\n`);
    await new Promise((r) => setTimeout(r, 60));
  }
  res.write(`event: ${eventName}.completed\ndata: ${JSON.stringify({ content: text })}\n\n`);
  res.end(`event: run.completed\ndata: {}\n\n`);
}

const READ_ONLY = {
  error: "read_only",
  detail: "Lark 가 정본입니다. 이 사무실은 Lark 브리핑 데이터를 보여 주기만 합니다 — 변경은 Lark 에서 하세요.",
};

/**
 * 어떤 뷰를 보여 줄지는 보드의 **현재 이름**으로 정한다. DeskRPG 는 프로젝트 보드를 slug 이름으로
 * 먼저 만들고 PATCH 로 이름을 붙이므로, 생성 시점에 정하면 파이프라인 보드가 장부로 굳는다.
 */
export function viewOf(board) {
  return PIPELINE_RE.test(board.name ?? "") ? "pipeline" : "ledger";
}

/** 보드 slug → 이름. 재시작해도 유지되도록 파일에 남긴다. */
function createBoardRegistry(statePath) {
  const boards = new Map(
    existsSync(statePath) ? Object.entries(JSON.parse(readFileSync(statePath, "utf8"))) : [],
  );
  const save = () => {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(boards), null, 2));
    renameSync(tmp, statePath);
  };
  return {
    list: () => [...boards.values()],
    get: (slug) => boards.get(slug),
    ensure(slug, name) {
      const existing = boards.get(slug);
      if (existing) return { board: existing, created: false };
      const board = { slug, name: name || slug };
      boards.set(slug, board);
      save();
      return { board, created: true };
    },
    patch(slug, patch) {
      const board = boards.get(slug);
      if (!board) return null;
      if (typeof patch.name === "string") board.name = patch.name;
      if (typeof patch.description === "string") board.description = patch.description;
      save();
      return board;
    },
  };
}

export function createGateway({ officePath, token, statePath }) {
  if (!token || token.length < 16) throw new Error("FAMIGO_GATEWAY_TOKEN 은 16자 이상이어야 한다");
  const load = createOfficeSource(officePath);
  load(); // 시작 시점에 스키마를 한 번 검사한다 — 틀리면 바로 죽는다.
  const boards = createBoardRegistry(statePath);
  const runs = new Map();
  let seq = 0;

  const boardMeta = (b, office) => ({
    slug: b.slug,
    name: b.name,
    ...(b.description ? { description: b.description } : {}),
    is_current: false,
    total: cardsFor(viewOf(b), office).length,
  });

  const authorized = (req) => req.headers.authorization === `Bearer ${token}`;

  async function owner(req, res, url) {
    const office = load();
    const p = url.pathname;
    const board = url.searchParams.get("board") ?? "";
    const m = req.method;

    if (p === "/deskrpg/info" && m === "GET")
      return json(res, 200, {
        plugin: "deskrpg",
        version: PLUGIN_VERSION,
        capabilities: ["kanban", "cron", "events"],
        timezone: "Asia/Seoul",
        kanban: { dispatcher_present: false, attachments: false },
        dashboard_url: null,
      });
    if (p === "/deskrpg/kanban/boards") {
      if (m === "GET") return json(res, 200, { boards: boards.list().map((b) => boardMeta(b, office)), current: null });
      if (m === "POST") {
        const body = await readBody(req);
        if (typeof body.slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(body.slug))
          return json(res, 400, { error: "invalid_slug" });
        const { board: b, created } = boards.ensure(body.slug, body.name);
        return json(res, created ? 201 : 200, { board: boardMeta(b, office) });
      }
    }
    const boardPatch = /^\/deskrpg\/kanban\/boards\/([^/]+)$/.exec(p);
    if (boardPatch && m === "PATCH") {
      const b = boards.patch(decodeURIComponent(boardPatch[1]), await readBody(req));
      return b ? json(res, 200, { board: boardMeta(b, office) }) : json(res, 404, { error: "unknown_board" });
    }
    if (p === "/deskrpg/kanban/profiles" && m === "GET")
      return json(res, 200, {
        profiles: office.members.map((mb, i) => ({ name: mb.key, is_default: i === 0, description: mb.role ?? "" })),
      });
    if (p === "/deskrpg/kanban/board" && m === "GET") {
      const b = boards.get(board) ?? boards.ensure(board, board).board;
      return json(res, 200, renderBoard(viewOf(b), office, url.searchParams.get("include_archived") === "true"));
    }
    const task = /^\/deskrpg\/kanban\/tasks\/([^/]+)$/.exec(p);
    if (task && m === "GET") {
      const b = boards.get(board);
      const card = b && cardsFor(viewOf(b), office).find((c) => c.id === decodeURIComponent(task[1]));
      if (!card) return json(res, 404, { error: "not_found" });
      return json(res, 200, {
        task: card,
        comments: [],
        events: [],
        attachments: null,
        links: { parents: [], children: [] },
        runs: [],
      });
    }
    if (p === "/deskrpg/kanban/links" && m === "GET") return json(res, 200, { links: [], board });
    if (p === "/deskrpg/kanban/runs" && m === "GET") return json(res, 200, { runs: [], board, truncated: false });
    if (p === "/deskrpg/kanban/events" && m === "GET")
      return json(res, 200, { events: [], board, kind: "status", truncated: false });
    if (p === "/deskrpg/kanban/dispatch" && m === "POST") return json(res, 200, { dispatched: [], skipped: [] });
    if (p === "/deskrpg/events" && m === "GET")
      // 변화는 office.json 재생성으로 들어온다. 이벤트 스트림은 비어 있다(재생 없음).
      return json(res, 200, { events: [], cursor: "0", has_more: false });
    if (m !== "GET") return json(res, 403, READ_ONLY);
    return json(res, 404, { error: "not_found" });
  }

  async function profile(req, res, name, path) {
    const office = load();
    if (!office.members.some((mb) => mb.key === name)) return json(res, 404, { error: "unknown_profile" });
    const m = req.method;
    if (m === "GET" && path === "/health") return json(res, 200, { status: "ok" });
    if (m === "GET" && path === "/v1/models")
      return json(res, 200, { object: "list", data: [{ id: "famigo-lark-office", object: "model" }] });
    if (m === "GET" && path === "/v1/capabilities")
      return json(res, 200, {
        features: { sessions: true, runs: true },
        endpoints: {
          sessions: { method: "POST", path: "/api/sessions" },
          sessionChat: { method: "POST", path: "/api/sessions/:id/chat/stream" },
          runs: { method: "POST", path: "/v1/runs" },
          runEvents: { method: "GET", path: "/v1/runs/:id/events" },
        },
      });
    if (m === "POST" && path === "/api/sessions")
      return json(res, 200, {
        object: "hermes.session",
        session: { id: `famigo-session-${++seq}`, source: "api_server", message_count: 0 },
      });
    if (m === "POST" && /^\/api\/sessions\/[^/]+\/chat\/stream$/.test(path)) {
      const body = await readBody(req);
      const input = String(body.message ?? body.input ?? body.content ?? "");
      return sse(res, "assistant", composeReply(name, input, office));
    }
    if (m === "POST" && path === "/v1/runs") {
      const body = await readBody(req);
      const id = `famigo-run-${++seq}`;
      const room = String(req.headers["x-hermes-session-key"] ?? "").includes("-room-");
      runs.set(id, { name, input: String(body.input ?? ""), meeting: !room });
      if (runs.size > 500) runs.delete(runs.keys().next().value);
      return json(res, 202, { run_id: id });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
    if (m === "GET" && ev) {
      const run = runs.get(decodeURIComponent(ev[1]));
      if (!run || run.name !== name) return json(res, 404, { error: "not_found" });
      return sse(res, "message", composeReply(name, run.input, office, { meeting: run.meeting }));
    }
    if (m !== "GET") return json(res, 403, READ_ONLY);
    return json(res, 404, { error: "not_found" });
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const handle = async () => {
      if (req.method === "GET" && /^(\/p\/[^/]+)?\/health$/.test(url.pathname)) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("ok");
      }
      // gateway-probe: 인증 없는 /v1/models 는 JSON 401 이어야 Hermes API 서버로 판정된다.
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      if (url.pathname === "/v1/models") return json(res, 200, { object: "list", data: [] });
      if (url.pathname.startsWith("/deskrpg/")) return owner(req, res, url);
      const pm = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (pm) return profile(req, res, decodeURIComponent(pm[1]), pm[2]);
      return json(res, 404, { error: "not_found" });
    };
    handle().catch((err) => {
      console.error(`[famigo-gateway] ${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: "gateway_error", detail: err.message });
      else res.end();
    });
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      office: { type: "string", default: "out/office.json" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8642" },
      state: { type: "string" },
    },
  });
  const officePath = resolve(values.office);
  const statePath = values.state ? resolve(values.state) : join(dirname(officePath), "gateway-boards.json");
  const server = createGateway({ officePath, token: process.env.FAMIGO_GATEWAY_TOKEN, statePath });
  server.listen(Number(values.port), values.host, () => {
    console.log(`[famigo-gateway] http://${values.host}:${values.port} · office ${officePath}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
