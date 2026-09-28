#!/usr/bin/env node
// 설치된 DeskRPG 에서 오피스 외형 목록을 뽑아 out/looks.json(로컬)으로 둔다.
//
// 왜 저장소에 두지 않는가: 외형 이름·설명은 DeskRPG(Dante Labs, Sustainable Use License)의 내용이다. public 저장소에
// 옮겨 싣지 않고, 이 Mac 에 설치된 사본에서 그때그때 읽는다. DeskRPG 가 외형을 바꿔도 설치 때마다 따라간다
// (전에는 손으로 뽑은 목록이 낡으면 validateOfficeAppearance 가 'unknown office look' 으로 거절했다).
//
//   node scripts/extract-looks.mjs --deskrpg ~/.famigo-office/deskrpg/node_modules/deskrpg --out out/looks.json

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const FIELDS = ["name", "nameEn", "category", "subtitle", "stance", "outfit", "bodyType"];

/** office-looks*.ts 원문 → [{ id, name, category, subtitle, stance, outfit, bodyType }] */
export function parseLooks(source) {
  const looks = [];
  const re = /\bid:\s*"(office-[a-z0-9-]+)"([\s\S]*?)(?=\bid:\s*"office-|$)/g;
  for (const m of source.matchAll(re)) {
    const look = { id: m[1] };
    for (const f of FIELDS) {
      const v = new RegExp(`\\b${f}:\\s*"([^"]*)"`).exec(m[2]);
      if (v) look[f] = v[1];
    }
    looks.push(look);
  }
  return looks;
}

export function validateLooks(looks) {
  const problems = [];
  if (looks.length < 10) problems.push(`외형이 ${looks.length}개뿐이다`);
  const ids = new Set();
  for (const l of looks) {
    if (ids.has(l.id)) problems.push(`중복 ${l.id}`);
    ids.add(l.id);
    for (const f of ["name", "category", "bodyType"]) if (!l[f]) problems.push(`${l.id}.${f} 없음`);
  }
  if (problems.length) throw new Error(`외형 추출 결과가 이상하다 — DeskRPG 원문 구조가 바뀌었는지 확인:\n  - ${problems.join("\n  - ")}`);
  return looks;
}

function main() {
  const { values } = parseArgs({ options: { deskrpg: { type: "string" }, out: { type: "string", default: "out/looks.json" } } });
  if (!values.deskrpg) throw new Error("--deskrpg <DeskRPG 패키지 경로> 가 필요하다");
  const dir = join(values.deskrpg, "src", "game", "three");
  const source = ["office-looks.ts", "office-looks-extended.ts"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const looks = validateLooks(parseLooks(source));
  writeFileSync(`${values.out}.tmp`, JSON.stringify(looks, null, 2) + "\n");
  renameSync(`${values.out}.tmp`, values.out);
  const count = (k) => Object.entries(looks.reduce((a, l) => ({ ...a, [l[k]]: (a[l[k]] ?? 0) + 1 }), {})).map(([v, n]) => `${v} ${n}`).join(" · ");
  console.log(`✓ ${values.out} · 외형 ${looks.length}종 (${count("category")} | ${count("bodyType")})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
