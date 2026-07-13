#!/usr/bin/env python3
"""生成 docs/data/adcodes.json：全国 adcode → 中文名 扁平表（省/市/区县三级）。

用途：把官方预警（WMO CAP feed，每条带 6 位行政区划码）匹配、显示到本站的
区县；adcode 与 regions.json 同源（阿里 DataV GeoAtlas），天然对齐。

数据源：阿里 DataV GeoAtlas（与 build_regions.py 同源）。
一次性脚本，行政区划变更时重跑即可。
"""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "adcodes.json"
BASE = "https://geo.datav.aliyun.com/areas_v3/bound"


def get(adcode):
    url = f"{BASE}/{adcode}_full.json"
    req = urllib.request.Request(url, headers={"User-Agent": "typhoonandcicada-build"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def feats(adcode):
    try:
        data = get(adcode)
    except Exception as e:
        print(f"  skip {adcode}: {e}")
        return []
    out = []
    for f in data.get("features", []):
        p = f.get("properties", {})
        if p.get("adcode") and p.get("name"):
            out.append((str(p["adcode"]), p["name"], p.get("level")))
    return out


def main():
    names = {}   # adcode -> 中文名
    provinces = feats(100000)
    print(f"{len(provinces)} provinces")
    for pad, pname, _ in provinces:
        names[pad] = pname
        time.sleep(0.1)
        cities = feats(pad)
        for cad, cname, clevel in cities:
            names[cad] = cname
            # 直辖市/特别行政区：children 已是区级，无需再下钻
            if clevel == "district":
                continue
            time.sleep(0.1)
            for dad, dname, _ in feats(cad):
                names[dad] = dname
        n = len([k for k in names if k.startswith(pad[:2])])
        print(f"  {pname}: 累计 {n} 名")

    OUT.write_text(json.dumps(names, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, {len(names)} 条)")


if __name__ == "__main__":
    main()
