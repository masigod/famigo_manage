// 외부 연결 차단기 회귀 테스트 — FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "egress-guard.cjs");

test("차단기: 외부 호스트·IP 는 연결 전에 거절, 루프백은 허용", () => {
  const out = execFileSync(process.execPath, ["--require", GUARD, "-e", `
    const { isAllowed } = require(${JSON.stringify(GUARD)});
    const http = require("node:http");
    console.log(JSON.stringify(["localhost", "127.0.0.1", "::1", "0.0.0.0", "api.github.com", "8.8.8.8", "localhost.evil.io"].map(isAllowed)));
    fetch("https://api.github.com/").then(() => console.log("LEAK"), (e) => console.log("BLOCKED", (e.cause || e).message));
  `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const [flags, result] = out.trim().split("\n");
  assert.deepEqual(JSON.parse(flags), [true, true, true, true, false, false, false]);
  assert.match(result, /^BLOCKED egress blocked: api\.github\.com:443/);
});

test("차단기: 허용 목록(FAMIGO_EGRESS_ALLOW)으로만 넓힌다", () => {
  const out = execFileSync(process.execPath, ["--require", GUARD, "-e", `console.log(require(${JSON.stringify(GUARD)}).isAllowed("files.internal"))`], {
    encoding: "utf8",
    env: { ...process.env, FAMIGO_EGRESS_ALLOW: "files.internal" },
  });
  assert.equal(out.trim(), "true");
});
