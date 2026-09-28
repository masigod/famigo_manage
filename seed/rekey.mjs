#!/usr/bin/env node
// DeskRPG 저장 토큰 재암호화 — 서버 비밀(INTERNAL_RPC_SECRET)을 바꿀 때 한 번 돈다.
//
// 왜: DeskRPG 는 게이트웨이·프로필 토큰을 `INTERNAL_RPC_SECRET || JWT_SECRET` 에서 만든 키로 AES-256-GCM
// 암호화해 DB 에 둔다(src/lib/gateway-resources.ts getGatewayCipherKey). 내부 RPC 비밀을 JWT 비밀과
// 분리하면 키가 바뀌어 기존 토큰을 못 풀고 칸반이 500 이 난다(2026-09-28 실측). 게이트웨이 PATCH 도
// 옛 토큰을 먼저 복호화하므로 API 로는 고칠 수 없다 — DB 에서 옮긴다.
//
// 성질: 멱등(새 키로 이미 풀리면 건너뜀) · 바꿀 게 있을 때만 먼저 백업 · 한 트랜잭션 ·
//       어느 키로도 안 풀리는 값이 있으면 아무것도 쓰지 않고 멈춤 · 토큰 원문은 출력하지 않음.
//
//   DESKRPG_FROM_SECRET=<옛 비밀> DESKRPG_TO_SECRET=<새 비밀> \
//   node seed/rekey.mjs --db ~/.deskrpg/data/deskrpg.db --deskrpg ~/.famigo-office/deskrpg/node_modules/deskrpg
// DeskRPG 가 꺼져 있을 때 돌린다(install-mac.sh 가 서비스를 내린 뒤 부른다).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** 암호화된 토큰이 있는 곳 — schema-sqlite.ts 의 *_encrypted 컬럼 중 이 키를 쓰는 것 전부. */
export const ENCRYPTED_COLUMNS = [
  { table: "gateway_resources", column: "token_encrypted" },
  { table: "hermes_profiles", column: "token_encrypted" },
];

export const keyOf = (secret) => createHash("sha256").update(secret).digest();

export function encrypt(token, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${body.toString("base64url")}`;
}

export function decrypt(payload, key) {
  const [version, iv, tag, body] = String(payload).split(":");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("invalid_payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** 값 하나: 새 키로 풀리면 그대로, 옛 키로 풀리면 새 키로, 둘 다 아니면 null. */
export function rekeyValue(payload, fromKey, toKey) {
  try {
    decrypt(payload, toKey);
    return { status: "already", value: payload };
  } catch {}
  try {
    return { status: "migrated", value: encrypt(decrypt(payload, fromKey), toKey) };
  } catch {
    return { status: "unreadable", value: null };
  }
}

/** db: better-sqlite3 호환({prepare, transaction}). 반환: 표별 집계. 풀 수 없는 값이 있으면 쓰지 않고 throw. */
export function rekeyDatabase(db, fromSecret, toSecret, { backup = null } = {}) {
  const fromKey = keyOf(fromSecret);
  const toKey = keyOf(toSecret);
  const plan = [];
  const summary = {};
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const rows = db.prepare(`SELECT rowid AS rid, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all();
    const s = (summary[`${table}.${column}`] = { already: 0, migrated: 0, unreadable: 0 });
    for (const r of rows) {
      const out = rekeyValue(r.v, fromKey, toKey);
      s[out.status] += 1;
      if (out.status === "migrated") plan.push({ table, column, rid: r.rid, value: out.value });
    }
  }
  const unreadable = Object.values(summary).reduce((n, s) => n + s.unreadable, 0);
  if (unreadable) throw new Error(`옛 비밀로도 새 비밀로도 풀리지 않는 토큰 ${unreadable}건 — 아무것도 바꾸지 않았다`);
  if (plan.length) {
    if (backup) backup();
    db.transaction(() => {
      for (const p of plan) db.prepare(`UPDATE ${p.table} SET ${p.column} = ? WHERE rowid = ?`).run(p.value, p.rid);
    })();
  }
  return summary;
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      deskrpg: { type: "string" },
    },
  });
  const from = process.env.DESKRPG_FROM_SECRET;
  const to = process.env.DESKRPG_TO_SECRET;
  if (!values.db || !values.deskrpg || !from || !to) throw new Error("--db --deskrpg 와 DESKRPG_FROM_SECRET·DESKRPG_TO_SECRET 가 필요하다");
  if (from === to) return console.log("✓ 재암호화 불필요 (같은 비밀)");
  const Database = createRequire(join(values.deskrpg, "package.json"))("better-sqlite3");
  const db = new Database(values.db);
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${values.db}.before-rekey-${stamp}`;
    const summary = rekeyDatabase(db, from, to, {
      backup: () => {
        db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
        chmodSync(backupPath, 0o600); // 사용자·토큰(암호문)이 든 DB 사본
        console.log(`  백업: ${backupPath}`);
      },
    });
    const line = Object.entries(summary)
      .map(([k, s]) => `${k} 옮김 ${s.migrated} · 이미 ${s.already}`)
      .join(" · ");
    console.log(`✓ 저장 토큰 재암호화 (${line})`);
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
