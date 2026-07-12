#!/usr/bin/env python3
"""建沿海采样表：为沿海/海岛区县预存一个「外海暴露采样点」。

县城中心常落在岛群/港湾内侧遮蔽格点（嵊泗县城才 2.5m，外海却 7.5m），
所以运行时不能只查县城坐标。这里对沿海省份的每个区县，向外海撒一圈候选点，
用 Open-Meteo Marine（海格点才有数据，陆地返回空）判定哪些是海、哪个方向最开阔，
存下最暴露的那个采样点。运行时对沿海地点用它查浪高即可。

一次性/偶尔重跑（行政区划变更时）。批量多点查询，调用量很小。
输出 docs/data/coastal.json： { "round(lat*100),round(lng*100)": [sea_lat, sea_lng], ... }
"""
import json, math, time, sys, urllib.request, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGIONS = ROOT / "docs/data/regions.json"
OUT = ROOT / "docs/data/coastal.json"

# 有海岸线的省级行政区
COASTAL_PROV = {
    "辽宁省", "河北省", "天津市", "山东省", "江苏省", "上海市", "浙江省",
    "福建省", "广东省", "广西壮族自治区", "海南省", "台湾省",
    "香港特别行政区", "澳门特别行政区",
}
# 临海地级市白名单（只探这些市的区县，剔除内陆区县——省调用、避免误判，
# 海南全省沿海故整省纳入）。名单可增补；宁可多列，非海市里的区县探不到海会自动落选。
COASTAL_CITY = {
    "大连", "丹东", "锦州", "营口", "盘锦", "葫芦岛", "秦皇岛", "唐山", "沧州",
    "青岛", "烟台", "威海", "潍坊", "东营", "滨州", "日照", "连云港", "盐城", "南通",
    "舟山", "宁波", "台州", "温州", "嘉兴", "福州", "厦门", "泉州", "漳州", "莆田", "宁德",
    "广州", "深圳", "珠海", "汕头", "湛江", "茂名", "阳江", "江门", "惠州", "汕尾",
    "潮州", "揭阳", "东莞", "中山", "北海", "钦州", "防城港",
}
WHOLE_COASTAL_PROV = {"上海市", "天津市", "海南省", "香港特别行政区", "澳门特别行政区", "台湾省"}

def is_coastal_city(prov, city):
    if prov in WHOLE_COASTAL_PROV:
        return True
    return any(c in city for c in COASTAL_CITY)
BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315]  # N NE E SE S SW W NW
DIST_KM = [42]               # 外海暴露探测距离（单圈，减少调用量）
R = 6371.0
BATCH = 150                  # 每次 Marine API 携带的点数

def dest(lat, lng, brg, d):
    br, la1, lo1, dr = map(math.radians, (brg, lat, lng, 0)); dr = d / R
    la2 = math.asin(math.sin(la1) * math.cos(dr) + math.cos(la1) * math.sin(dr) * math.cos(br))
    lo2 = lo1 + math.atan2(math.sin(br) * math.sin(dr) * math.cos(la1),
                           math.cos(dr) - math.sin(la1) * math.sin(la2))
    return round(math.degrees(la2), 4), round(math.degrees(lo2), 4)

def marine_batch(pts):
    """pts: [(lat,lng)]; 返回 [max_wave or None]（None=陆地/无数据）"""
    la = ",".join(str(p[0]) for p in pts)
    lo = ",".join(str(p[1]) for p in pts)
    url = ("https://marine-api.open-meteo.com/v1/marine?latitude=%s&longitude=%s"
           "&hourly=wave_height&forecast_days=1&timezone=Asia%%2FShanghai" % (la, lo))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                d = json.load(r)
            arr = d if isinstance(d, list) else [d]
            out = []
            for o in arr:
                wh = (o.get("hourly") or {}).get("wave_height") or []
                vals = [x for x in wh if x is not None]
                out.append(max(vals) if vals else None)
            return out
        except Exception as e:
            print("  retry %d: %s" % (attempt, e), file=sys.stderr)
            time.sleep(2 + attempt * 2)
    return [None] * len(pts)

def main():
    regions = json.loads(REGIONS.read_text(encoding="utf-8"))
    # 收集所有候选点，去重后批量查
    districts = []   # (key, lat0, lng0, [(bearing, dist, plat, plng)])
    cand = {}        # (plat,plng) -> None
    for prov, pobj in regions.items():
        if prov not in COASTAL_PROV:
            continue
        for city, cobj in (pobj.get("cities") or {}).items():
            if not is_coastal_city(prov, city):
                continue
            for dname, ll in (cobj.get("districts") or {}).items():
                lat0, lng0 = ll[0], ll[1]
                key = "%d,%d" % (round(lat0 * 100), round(lng0 * 100))
                cs = []
                for d in DIST_KM:
                    for b in BEARINGS:
                        p = dest(lat0, lng0, b, d)
                        cs.append((b, d, p[0], p[1])); cand[p] = None
                districts.append((key, dname, lat0, lng0, cs))
    pts = list(cand.keys())
    print("沿海省份候选点 %d 个（%d 区县），分 %d 批查询…" %
          (len(pts), len(districts), math.ceil(len(pts) / BATCH)))
    for i in range(0, len(pts), BATCH):
        chunk = pts[i:i + BATCH]
        res = marine_batch(chunk)
        for p, w in zip(chunk, res):
            cand[p] = w
        print("  %d/%d" % (min(i + BATCH, len(pts)), len(pts)), flush=True)
        time.sleep(0.4)

    coastal = {}
    n_coast = 0
    for key, dname, lat0, lng0, cs in districts:
        sea = {}  # bearing -> {dist: wave}
        for b, d, pl, pn in cs:
            w = cand.get((pl, pn))
            if w is not None:
                sea.setdefault(b, {})[d] = (w, pl, pn)
        # 开阔方向：22 和 42km 都是海；否则退而取任一 42km 海点
        open_dirs = [b for b in sea if 22 in sea[b] and 42 in sea[b]]
        pick = None
        if open_dirs:
            # 最暴露：开阔方向里 42km 浪最大的
            pick = max((sea[b][42] for b in open_dirs), key=lambda t: t[0])
        else:
            far = [sea[b][42] for b in sea if 42 in sea[b]]
            if far:
                pick = max(far, key=lambda t: t[0])
        if pick:
            coastal[key] = [pick[1], pick[2]]
            n_coast += 1
    OUT.write_text(json.dumps(coastal, ensure_ascii=False,
                              separators=(",", ":")), encoding="utf-8")
    print("沿海区县 %d 个，写入 %s（%d 字节）" %
          (n_coast, OUT.name, OUT.stat().st_size))

if __name__ == "__main__":
    main()
