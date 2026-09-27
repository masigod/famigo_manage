#!/usr/bin/env python3
"""원천 파일의 **구조만** 출력한다 — 값은 한 글자도 내보내지 않는다.

왜: 빌더의 필드 후보가 실제 스키마와 맞는지 보려면 키 이름과 타입이 필요하다. 그런데 값에는
실명·원문이 있다. 이 도구는 값을 타입으로 바꾸고, 사람 이름일 수 있는 키(비ASCII·레코드 맵의 키)도
가린다. 출력은 채팅에 붙여도 되는 모양이다.

사용: python3 office/shape.py [--data-dir ~/famigo_campaign/briefs/data]
"""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

ASCII_KEY = re.compile(r"^[A-Za-z0-9_.\-]{1,40}$")
MAX_DEPTH = 6


def merged(records):
    """레코드 여러 개의 필드를 합친다 — 일부 레코드에만 있는 필드(예: 마지막 발화 시각)를 놓치지 않게."""
    out = {}
    for r in records[:200]:
        for k, x in r.items():
            if isinstance(out.get(k), dict) and isinstance(x, dict):
                out[k] = merged([out[k], x])
            elif k not in out or out[k] is None:
                out[k] = x
    return out


def skeleton(v, depth=0):
    if depth > MAX_DEPTH:
        return "…"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if v is None:
        return "null"
    if isinstance(v, str):
        if re.match(r"^\d{4}-\d{2}-\d{2}", v):
            return "str(date)"
        return "str"
    if isinstance(v, list):
        if not v:
            return "list(0)"
        head = v[0]
        if all(isinstance(x, dict) for x in v[:200]):
            head = merged(v)
        return {f"list({len(v)}) of": skeleton(head, depth + 1)}
    if isinstance(v, dict):
        keys = list(v)
        # 레코드 맵(키가 id·이름): 값들이 같은 모양의 레코드면 키를 가리고 가장 긴 표본 하나만.
        # 개수로 판정하면 사람이 몇 명 안 될 때 영문 실명 키가 샌다.
        if len(keys) >= 2 and all(isinstance(x, dict) for x in v.values()):
            shapes = collections.Counter(frozenset(x) for x in v.values())
            if shapes.most_common(1)[0][1] * 2 >= len(keys):
                sample = merged(list(v.values()))
                return {f"<map: {len(keys)} keys>": skeleton(sample, depth + 1)}
        out = {}
        for k in keys:
            shown = k if ASCII_KEY.match(k) else "<non-ascii key>"
            while shown in out:
                shown += "'"
            out[shown] = skeleton(v[k], depth + 1)
        return out
    return type(v).__name__


def first_jsonl(path: Path):
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                return json.loads(line)
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=Path("~/famigo_campaign/briefs/data").expanduser())
    args = ap.parse_args(argv)
    d = args.data_dir.expanduser()
    report = {}
    for name in ("people.json", "rooms.json", "campaigns.json"):
        p = d / name
        report[name] = skeleton(json.loads(p.read_text(encoding="utf-8"))) if p.exists() else "없음"
    for name in ("todos.jsonl", "lark_daily.jsonl"):
        p = d / name
        report[name + " (첫 행)"] = skeleton(first_jsonl(p)) if p.exists() else "없음"
    raw = sorted((d / "raw").glob("*/*.jsonl")) if (d / "raw").is_dir() else []
    raw = [p for p in raw if not p.name.startswith("_") and "dm_" not in p.name]
    if raw:
        sample = raw[-1]
        report["raw (파일명 형식)"] = re.sub(r"__.*\.jsonl$", "__<room>.jsonl", f"{sample.parent.name}/{sample.name}")
        report["raw (첫 행)"] = skeleton(first_jsonl(sample))
        report["raw (파일 수)"] = len(raw)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
