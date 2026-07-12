#!/usr/bin/env python3
"""抓取中国及周边机场 METAR 实测，落成快照 docs/data/metar.json。

为什么要它：影响面板的「此刻本地」原来只用 Open-Meteo 数值模式，实测对照发现
模式在台风远离的减弱尾段会高报约一个风级（杭州个例：模式报 8 级，萧山机场
实测 50km/h≈7 级且在降，与地面体感/朋友反馈一致）。METAR 是真实观测，用它
锚定「此刻」。aviationweather.gov 不带 CORS，前端无法直连，故服务端抓成快照，
前端同源就近取站。国内国际交换的机场约 38 个，覆盖沿海台风高发大城市。

零依赖、纯标准库。抓取失败时保留旧快照，绝不清空。
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "metar.json"
# aviationweather 单次查询有约 70 条上限，超大 bbox 会把中国站挤掉，故按区分块查询再合并。
# 每块 minLat,minLon,maxLat,maxLon，覆盖中国大陆 + 台湾 + 海南。
TILES = [
    "38,118,54,135",  # 东北
    "34,110,43,123",  # 华北
    "27,116,35,124",  # 华东
    "27,108,35,117",  # 华中
    "20,105,27,118",  # 华南
    "15,107,21,118",  # 海南
    "21,97,34,108",   # 西南
    "34,88,50,111",   # 西北
    "27,78,37,98",    # 西藏
    "21,119,26,123",  # 台湾
]


def fetch(bbox):
    url = f"https://aviationweather.gov/api/data/metar?format=json&bbox={bbox}"
    req = urllib.request.Request(url, headers={"User-Agent": "typhoonandcicada/1.0 (public-good)"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    merged = {}  # icao -> record（同站多块命中时保留最新报文）
    ok = 0
    for bbox in TILES:
        try:
            raw = fetch(bbox)
            ok += 1
        except Exception as e:
            print(f"[metar] 分块 {bbox} 抓取失败: {e}", file=sys.stderr)
            continue
        for m in raw:
            icao = m.get("icaoId")
            lat, lon, t = m.get("lat"), m.get("lon"), m.get("reportTime")
            if not icao or lat is None or lon is None or not t:
                continue
            prev = merged.get(icao)
            if prev and prev["t"] >= t:  # 已有更新的报文
                continue
            # 只保留「此刻」需要的字段，风速单位为节(kt)，与前端约定一致
            merged[icao] = {
                "i": icao,
                "la": round(float(lat), 3),
                "lo": round(float(lon), 3),
                "t": t,
                "wd": m.get("wdir"),
                "ws": m.get("wspd"),   # 持续风速 kt
                "wg": m.get("wgst"),   # 阵风 kt（可能为 None）
                "wx": m.get("wxString"),
            }

    stations = list(merged.values())
    if not stations:  # 全部分块失败：保留旧快照，绝不清空
        print(f"[metar] {ok}/{len(TILES)} 分块成功但 0 站，保留旧快照", file=sys.stderr)
        return 0

    stations.sort(key=lambda s: s["i"])
    snap = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": "NOAA aviationweather.gov METAR",
        "stations": stations,
    }
    OUT.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
    print(f"[metar] 写入 {len(stations)} 站 → {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
