// 저장 토큰 재암호화 회귀 테스트 — DeskRPG gateway-resources.ts 와 같은 형식(v1:iv:tag:body, AES-256-GCM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt, encrypt, keyOf, rekeyDatabase } from "../seed/rekey.mjs";

/** better-sqlite3 모양의 최소 가짜 — rowid·UPDATE·트랜잭션만. */
function fakeDb(tables) {
  let inTx = false;
  const writes = [];
  return {
    tables,
    writes,
    prepare(sql) {
      const sel = /FROM (\w+) WHERE (\w+) IS NOT NULL/.exec(sql);
      if (sel) return { all: () => tables[sel[1]].map((r, i) => ({ rid: i + 1, v: r[sel[2]] })).filter((r) => r.v != null) };
      const upd = /UPDATE (\w+) SET (\w+) = \? WHERE rowid = \?/.exec(sql);
      return {
        run: (value, rid) => {
          assert.ok(inTx, "트랜잭션 밖에서 쓰지 않는다");
          tables[upd[1]][rid - 1][upd[2]] = value;
          writes.push(rid);
        },
      };
    },
    transaction: (fn) => () => {
      inTx = true;
      try {
        fn();
      } finally {
        inTx = false;
      }
    },
  };
}

const OLD = "old-jwt-secret-0123456789abcdef";
const NEW = "new-internal-rpc-secret-fedcba9876543210";

test("옛 키 토큰은 새 키로 옮기고, 원문은 그대로다", () => {
  const db = fakeDb({
    gateway_resources: [{ token_encrypted: encrypt("gw-token", keyOf(OLD)) }],
    hermes_profiles: [{ token_encrypted: encrypt("p1", keyOf(OLD)) }, { token_encrypted: encrypt("p2", keyOf(NEW)) }],
  });
  let backups = 0;
  const s = rekeyDatabase(db, OLD, NEW, { backup: () => (backups += 1) });
  assert.deepEqual(s["gateway_resources.token_encrypted"], { already: 0, migrated: 1, unreadable: 0 });
  assert.deepEqual(s["hermes_profiles.token_encrypted"], { already: 1, migrated: 1, unreadable: 0 });
  assert.equal(backups, 1);
  assert.equal(decrypt(db.tables.gateway_resources[0].token_encrypted, keyOf(NEW)), "gw-token");
  assert.equal(decrypt(db.tables.hermes_profiles[0].token_encrypted, keyOf(NEW)), "p1");
});

test("멱등: 두 번째 실행은 아무것도 쓰지 않고 백업도 안 만든다", () => {
  const db = fakeDb({ gateway_resources: [{ token_encrypted: encrypt("t", keyOf(NEW)) }], hermes_profiles: [] });
  let backups = 0;
  rekeyDatabase(db, OLD, NEW, { backup: () => (backups += 1) });
  assert.deepEqual([backups, db.writes.length], [0, 0]);
});

test("어느 키로도 안 풀리는 값이 있으면 하나도 바꾸지 않고 멈춘다", () => {
  const db = fakeDb({
    gateway_resources: [{ token_encrypted: encrypt("t", keyOf(OLD)) }],
    hermes_profiles: [{ token_encrypted: encrypt("x", keyOf("someone-else")) }],
  });
  assert.throws(() => rekeyDatabase(db, OLD, NEW), /풀리지 않는 토큰 1건/);
  assert.equal(db.writes.length, 0);
});
