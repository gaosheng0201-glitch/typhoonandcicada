#!/usr/bin/env python3
"""从 rain-history.json 生成前端用的精简分位表 docs/data/rain-percentile.json。

为什么要它：**全国一把尺不科学**。同样下 100mm，在屏东是第 16 百分位（家常便饭，
中位数 216mm），在北京是第 100 百分位（有记录以来最大，中位数仅 1.9mm）——而我们
原来对两者都判「③正面重创」。一个城市自己的台风降雨史，天然编码了它的气候背景与
承受力（灾害学里的 Vulnerability 维度），这正是绝对阈值看不见的。

做法：把 rain-history（262 城 × 85 场台风的 ERA5 客观过程雨量）按城市聚合成
排序数组 + 该城最强的几场，前端据此算「本次雨量排历史第几百分位」。

红线：只做**表达与标定**，不直接改判档；分位数是「罕见度」，不等于「后果严重度」。
ERA5 对极端峰值偏平滑，样本量也有限，故前端只在样本 ≥10 场时启用。
"""
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "data" / "rain-history.json"
OUT = ROOT / "docs" / "data" / "rain-percentile.json"
MIN_N = 5          # 少于这么多场就不收录（前端另按 ≥10 才启用）
TOP_N = 3          # 每城保留最强几场做锚点


def main():
    src = json.loads(SRC.read_text(encoding="utf-8"))
    by = defaultdict(list)
    for tfid, st in src.get("d", {}).items():
        for city, rec in (st.get("cities") or {}).items():
            mm = rec.get("totalMm")
            if mm is None:
                continue
            by[city].append((round(float(mm), 1), tfid[:4], st.get("name") or ""))

    out = {}
    for city, lst in by.items():
        if len(lst) < MIN_N:
            continue
        lst.sort(key=lambda x: -x[0])
        out[city] = {
            "v": sorted(x[0] for x in lst),                       # 升序，供算分位
            "top": [[f"{y}年{nm}", mm] for mm, y, nm in lst[:TOP_N]],
        }

    payload = {
        "meta": {
            "source": src.get("meta", {}).get("source", ""),
            "note": "城市历史台风过程雨量分位表（ERA5 再分析，极端峰值偏平滑，量级参考）",
            "cities": len(out),
        },
        "d": out,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    ns = sorted((len(v["v"]) for v in out.values()), reverse=True)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")
    print(f"  收录 {len(out)} 城；样本数 中位 {ns[len(ns)//2]}，≥10 场的 {sum(1 for n in ns if n >= 10)} 城")


if __name__ == "__main__":
    main()
