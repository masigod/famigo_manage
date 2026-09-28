// DeskRPG 오피스 외형 목록 — 설치된 DeskRPG 에서 추출한 로컬 파일(out/looks.json)을 읽는다.
// 저장소에는 싣지 않는다(DeskRPG 내용 · Sustainable Use License). 만드는 법: scripts/extract-looks.mjs
// (install-mac.sh 가 설치 때마다 돌린다). 테스트는 FAMIGO_LOOKS 로 합성 목록을 쓴다.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const path = process.env.FAMIGO_LOOKS || join(dirname(fileURLToPath(import.meta.url)), "..", "out", "looks.json");
if (!existsSync(path)) {
  throw new Error(`외형 목록이 없다: ${path} — bash scripts/install-mac.sh (또는 node scripts/extract-looks.mjs) 가 만든다`);
}

/** [{ id, name, category, subtitle, stance, outfit, bodyType }] */
export const OFFICE_LOOKS = Object.freeze(JSON.parse(readFileSync(path, "utf8")));
export const OFFICE_LOOK_IDS = Object.freeze(OFFICE_LOOKS.map((l) => l.id));
