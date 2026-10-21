"""把口径层 yaml 编译成前端可读的 json。

浏览器里没有 yaml 解析器，也不该为了读一份 114 行的声明去塞一个解析库。
口径层是**构建期输入**，编译成 json 后前端只读这一份。

用法：
    python tools/compile_metrics.py ../metric-layer/metrics/ledger.example.yaml -o data/metrics.json

改了 yaml 之后必须重跑，否则页面用的还是旧口径。
"""

from __future__ import annotations

import argparse
import json
import sys


def compile_layer(path: str) -> dict:
    try:
        import yaml
    except ModuleNotFoundError:
        sys.exit("需要 PyYAML：pip install pyyaml")

    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    tables = raw.get("tables") or {}
    ev = tables.get("events") or {}
    events_on = ev.get("join_on")
    if ev.get("table") and not events_on:
        raise SystemExit(
            "tables.events 声明了事件表但缺少 join_on；"
            "注意不要写成 on（YAML 1.1 会把它当布尔值）"
        )

    time = raw.get("time") or {}

    metrics = []
    for m in raw.get("metrics") or []:
        metrics.append({
            "key": m["key"],
            "name": m["name"],
            "aliases": list(m.get("aliases") or []),
            "expr": m["expr"],
            "unit": m.get("unit") or "",
            "note": m.get("note") or "",
            "needs_events": bool(m.get("needs_events")),
            "event_filter": m.get("event_filter") or "",
        })

    dims = []
    for d in raw.get("dimensions") or []:
        dims.append({
            "key": d["key"],
            "name": d["name"],
            "aliases": list(d.get("aliases") or []),
            "column": d["column"],
            "time_grain": bool(d.get("time_grain")),
            "default_true": bool(d.get("default_true")),
        })

    enums = {}
    for k, v in (raw.get("enums") or {}).items():
        enums[k] = {"column": v["column"], "values": list(v.get("values") or [])}

    return {
        "version": raw.get("version", 1),
        "name": raw.get("name", ""),
        "source": path.replace("\\", "/").split("/")[-1],
        "tables": {
            "main": tables.get("main"),
            "main_alias": tables.get("main_alias"),
            "events": ev.get("table") or "",
            "events_alias": ev.get("alias") or "",
            "events_on": events_on or "",
        },
        "time": {
            "field": time.get("field") or "",
            "format": time.get("format") or "%Y-%m-%d",
        },
        "metrics": metrics,
        "dimensions": dims,
        "enums": enums,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="口径层 yaml → 前端 json")
    ap.add_argument("yaml", help="口径层 yaml 路径")
    ap.add_argument("-o", "--out", required=True, help="输出 json 路径")
    args = ap.parse_args()

    data = compile_layer(args.yaml)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"{args.out}  <-  {args.yaml}")
    print(f"  指标 {len(data['metrics'])} · 维度 {len(data['dimensions'])} · 枚举 {len(data['enums'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
