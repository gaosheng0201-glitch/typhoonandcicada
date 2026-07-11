#!/usr/bin/env python3
"""WeatherNext 2 集合预报 → docs/data/ai/summary.json

设计文档：design/weathernext.md。等待数据集审批中——本脚本在缺少凭据时
安静退出（exit 0），因此可以先并入 CI，获批后加 Secrets 即自动生效。

环境变量：
  GCP_PROJECT   你的 GCP 项目 ID
  GCP_SA_KEY    服务账号 JSON（内容本身，CI 里来自 Secrets）
依赖：google-cloud-bigquery（仅 CI 安装；本地无凭据时不需要）

⚠️ 列名/表结构按典型假设编写，获批后先 `bq show --schema` 核实再启用（见设计文档清单第 3 步）。
"""
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "ai" / "summary.json"

DATASET = "weathernext_2_0_0"      # Analytics Hub 订阅后在项目里的数据集名（以实际为准）
TARGET_KM = 500                     # 预报路径多少公里内的城市纳入计算
GUST_HIT_KMH = 62                   # 8级阵风阈值 → hit_prob
STALL_HOURS = 36                    # 连续有雨达此时长 → 计入 stall_prob


def haversine(lat1, lng1, lat2, lng2):
    d = math.pi / 180
    a = (math.sin((lat2 - lat1) * d / 2) ** 2 +
         math.cos(lat1 * d) * math.cos(lat2 * d) * math.sin((lng2 - lng1) * d / 2) ** 2)
    return 2 * 6371 * math.asin(math.sqrt(a))


def target_cities(storms):
    """预报路径 TARGET_KM 内的地级市（城市级中心点，0.25°格点下区县精度无意义）。"""
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))
    cities = []
    for pn, prov in regions.items():
        for cn, c in prov["cities"].items():
            cities.append((f"{cn}", c["lat"], c["lng"]))
    picked = {}
    for s in storms:
        pts = s["track"][-4:] + (s["forecasts"].get("中国", {}).get("points") or [])
        for name, lat, lng in cities:
            if name in picked:
                continue
            if any(haversine(lat, lng, p["lat"], p["lng"]) <= TARGET_KM for p in pts):
                picked[name] = (lat, lng)
    return picked


# —— 查询模板（获批后核实列名再解除注释启用）——
# 假设行结构：init_time TIMESTAMP, lead_hours INT64, member INT64,
#             lat FLOAT64, lon FLOAT64, total_precipitation_6h FLOAT64,
#             wind_gust_10m FLOAT64 …
QUERY_TEMPLATE = """
SELECT lead_hours, member, lat, lon,
       total_precipitation_6h AS precip,
       wind_gust_10m AS gust
FROM `{project}.{dataset}.forecasts`
WHERE init_time = (SELECT MAX(init_time) FROM `{project}.{dataset}.forecasts`)
  AND lat BETWEEN {lat_min} AND {lat_max}
  AND lon BETWEEN {lon_min} AND {lon_max}
"""


def main():
    project = os.environ.get("GCP_PROJECT")
    if not project or not os.environ.get("GCP_SA_KEY"):
        print("weathernext: 凭据未配置，跳过（等待数据集审批）")
        return 0

    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    if not index.get("typhoons"):
        print("weathernext: 无活跃台风，跳过查询（零成本待机）")
        return 0

    storms = []
    for t in index["typhoons"]:
        f = DATA / f"typhoon_{t['tfid']}.json"
        if f.exists():
            storms.append(json.loads(f.read_text(encoding="utf-8")))
    cities = target_cities(storms)
    print(f"weathernext: {len(storms)} 台风 → {len(cities)} 个目标城市")

    # TODO(获批后)：
    # 1. from google.cloud import bigquery；用 GCP_SA_KEY 建 client
    # 2. 按台风包围盒执行 QUERY_TEMPLATE，取回成员级点位序列
    # 3. 对每城市取最近格点，计算：
    #    rain p10/p50/p90（过程累计）、gust p50/p90、
    #    hit_prob（gust>=GUST_HIT_KMH 成员占比）、
    #    stall_prob（连续 STALL_HOURS 有雨成员占比）、
    #    end_early/end_late（成员风雨结束时刻的两簇）
    # 4. 写 OUT（含 meta.attribution = "© DeepMind Technologies Limited"）
    print("weathernext: 查询逻辑待表结构核实后启用（design/weathernext.md 清单第3步）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
