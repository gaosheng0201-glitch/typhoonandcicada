#!/usr/bin/env python3
"""判定口径的抽样自检：复现 panel.js 的核心链路，批量跑「多台风 × 多城市 × 多时刻」。

为什么要它：判定逻辑越来越多（相关半径、象限订正、窗口分离、分位标定），靠手点
页面测不过来，也测不了「不同时刻」。这个脚本用与前端**同源**的数据（温州台风网
路径 + Open-Meteo 逐时）复现 assess() 的关键步骤，可注入任意「现在时刻」，用于
回归与稳定性检查。

它不是前端的替身，只覆盖核心判据：相关性（含象限订正）、风雨窗口、已发生/未来
分离、档位、历史分位。

用法：
  python3 scripts/sanity_check.py 202613                 # 指定台风，当前时刻
  python3 scripts/sanity_check.py 202613 --sweep         # 叠加多时刻推演（稳定性）
"""
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BJT = timezone(timedelta(hours=8))
RAIN_ON, GUST_ON, GAP_H = 1.5, 62.0, 6

# 抽样城市：覆盖不同象限与距离（名字须与 regions.json 的城市键一致）
CITIES = ["杭州市", "上海市区", "宁波市", "南京市", "合肥市",
          "福州市", "武汉市", "广州市", "温州市", "青岛市"]


def get(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": "typhoonandcicada-selftest"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8"))


def hav(a, b, c, d):
    R, p = 6371.0, math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def bearing(a, b, c, d):
    p = math.pi / 180
    y = math.sin((d - b) * p) * math.cos(c * p)
    x = math.cos(a * p) * math.sin(c * p) - math.sin(a * p) * math.cos(c * p) * math.cos((d - b) * p)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def est_gale(pw):
    pw = int(pw or 0)
    return (400 if pw >= 16 else 350 if pw >= 14 else 300 if pw >= 12 else
            230 if pw >= 10 else 160 if pw >= 8 else 110 if pw >= 6 else 70)


def ptime(s):
    s = s.replace("T", " ").split("+")[0].split(".")[0]
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=BJT).timestamp()


def load_city_coords():
    reg = json.loads((ROOT / "docs" / "data" / "regions.json").read_text(encoding="utf-8"))
    out = {}
    for prov, pv in reg.items():
        for city, cv in (pv.get("cities") or {}).items():
            out[city] = (cv["lat"], cv["lng"])
    return out


def load_storm(tfid):
    d = get(f"https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo/{tfid}")
    pts = d.get("points", [])
    fcs = {}
    for i in range(len(pts) - 1, -1, -1):
        for fc in pts[i].get("forecast") or []:
            if fc.get("tm") and fc["tm"] not in fcs and fc.get("forecastpoints"):
                fcs[fc["tm"]] = fc["forecastpoints"]
        if fcs:
            break
    fc = fcs.get("中国") or (list(fcs.values())[0] if fcs else [])
    return d.get("name"), pts, fc


def load_wx(lat, lng):
    """逐时风雨 + 前期影响雨量 Pa 的土壤饱和度。
    一次取 14 天（前端是 hourly 7 天 + daily 14 天两次请求），这里合并成一次；
    窗口搜索同样限定在最近点 ±36/48h，故与前端结果一致。"""
    d = get(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}"
            f"&hourly=precipitation,wind_gusts_10m&daily=precipitation_sum"
            f"&past_days=14&forecast_days=7&timezone=Asia%2FShanghai")
    h = d["hourly"]
    t = [datetime.strptime(x, "%Y-%m-%dT%H:%M").replace(tzinfo=BJT).timestamp() for x in h["time"]]
    # Pa = Σ Kⁱ·P(i天前)，K=0.85；w = min(1, Pa/100)——与 panel.js 同口径
    dl = d.get("daily", {})
    days, sums = dl.get("time", []), dl.get("precipitation_sum", [])
    today = datetime.now(BJT).strftime("%Y-%m-%d")
    pa = 0.0
    past = [(dd, v) for dd, v in zip(days, sums) if dd < today and v is not None]
    for i, (_dd, v) in enumerate(reversed(past)):      # i=0 是昨天
        pa += (0.85 ** i) * v
    w = min(1.0, pa / 100.0)
    return t, h["precipitation"], h["wind_gusts_10m"], w


def assess(lat, lng, pts, fc, wx, now_ep, pct_tab):
    """复现 panel.js assess() 的核心判据。"""
    seq = [{"lat": float(p["lat"]), "lng": float(p["lng"]), "power": p.get("power"),
            "ep": ptime(p["time"])} for p in pts]
    seq += [{"lat": float(p["lat"]), "lng": float(p["lng"]), "power": p.get("power"),
             "ep": ptime(p["time"])} for p in fc]
    for p in seq:
        p["dist"] = hav(lat, lng, p["lat"], p["lng"])
    closest = min(seq, key=lambda p: p["dist"])

    wr = est_gale(closest["power"])
    # 象限订正的降雨相关半径
    prev = [p for p in seq if p["ep"] <= closest["ep"]]
    nxt = [p for p in seq if p["ep"] > closest["ep"]]
    a_, b_ = (prev[-1] if prev else seq[0]), (nxt[0] if nxt else seq[-1])
    dirf = None
    if a_ is not b_:
        mv = bearing(a_["lat"], a_["lng"], b_["lat"], b_["lng"])
        rel = (bearing(closest["lat"], closest["lng"], lat, lng) - mv + 360) % 360
        dirf = 0.65 + 0.35 * math.cos(math.radians(rel - 45))
    base = min(600, max(300, wr * 2.5))
    rr = base if dirf is None else max(150, base * dirf)
    in_range = [p for p in seq if p["dist"] < est_gale(p["power"])]
    relevant = bool(in_range) or closest["dist"] <= rr

    # 风雨窗口（含最近时刻的那段）
    t, pr, gu, soil_w = wx
    rain = past = future = 0
    win = None
    if relevant:
        anchor = closest["ep"]
        lo, hi = anchor - 36 * 3600, anchor + 48 * 3600
        segs, cur = [], None
        for i, tt in enumerate(t):
            if tt < lo or tt > hi:
                continue
            if (pr[i] or 0) >= RAIN_ON or (gu[i] or 0) >= GUST_ON:
                if cur and tt - t[cur[1]] > GAP_H * 3600:
                    segs.append(cur); cur = None
                cur = (i, i) if not cur else (cur[0], i)
        if cur:
            segs.append(cur)
        seg = next((s for s in segs if t[s[0]] <= anchor <= t[s[1]] + GAP_H * 3600), None)
        if not seg and segs:
            seg = min(segs, key=lambda s: min(abs(t[s[0]] - anchor), abs(t[s[1]] - anchor)))
        if seg:
            win = (t[seg[0]], t[seg[1]])
            for i in range(seg[0], seg[1] + 1):
                v = pr[i] or 0
                rain += v
                if t[i] <= now_ep:
                    past += v
                else:
                    future += v
    rain, past, future = round(rain), round(past), round(future)

    # 档位：雨臂按土壤湿度动态下调（与 panel.js 同口径）+ 风臂
    pw = int(closest["power"] or 0)
    wet = 1 - 0.4 * soil_w
    level = 1
    if rain >= 60 * wet or (closest["dist"] < wr and pw >= 8):
        level = 2
    if rain >= 150 * wet or (closest["dist"] < 200 and pw >= 10):
        level = 3
    if rain >= 250 or (closest["dist"] < 100 and pw >= 14):   # 档4 不随湿度下调
        level = 4

    # 阶段
    phase = "approach"
    if win and now_ep >= win[0]:
        phase = "after" if now_ep > win[1] else "during"

    pct = None
    if pct_tab and rain > 0:
        rec = pct_tab.get("_city")
        if rec and len(rec["v"]) >= 10:
            pct = round(100 * sum(1 for v in rec["v"] if v <= rain) / len(rec["v"]))
    return dict(dist=round(closest["dist"]), pw=pw, rr=round(rr), dirf=dirf,
                relevant=relevant, rain=rain, past=past, future=future, soil=round(soil_w, 2),
                level=level, phase=phase, pct=pct, win=win)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sweep = "--sweep" in sys.argv
    tfid = args[0] if args else "202613"
    coords = load_city_coords()
    pct_all = json.loads((ROOT / "docs" / "data" / "rain-percentile.json").read_text(encoding="utf-8"))["d"]
    name, pts, fc = load_storm(tfid)
    now = datetime.now(timezone.utc).timestamp()
    print(f"=== {name} ({tfid}) · 现在 {datetime.fromtimestamp(now, BJT):%Y-%m-%d %H:%M} 北京时 ===\n")
    print(f"{'城市':<7}{'距离':>7}{'雨半径':>7}{'向':>5}{'相关':>5}{'过程':>6}{'已下':>6}{'土湿':>6}{'档':>3}{'阶段':>7}{'分位':>5}")
    print("-" * 72)
    rows = []
    for c in CITIES:
        if c not in coords:
            continue
        lat, lng = coords[c]
        try:
            wx = load_wx(lat, lng)
        except Exception as e:
            print(f"{c:<7} 降水拉取失败: {e}")
            continue
        tab = {"_city": pct_all.get(c)}
        r = assess(lat, lng, pts, fc, wx, now, tab)
        rows.append((c, lat, lng, wx, r))
        d = f"{r['dirf']:.2f}" if r["dirf"] is not None else "  - "
        print(f"{c:<7}{r['dist']:6d}km{r['rr']:6d}km{d:>6}{'是' if r['relevant'] else '否':>5}"
              f"{r['rain']:5d}mm{r['past']:5d}mm{r['soil']:6.2f}{r['level']:3d}"
              f"{r['phase']:>8}{(str(r['pct'])+'%') if r['pct'] is not None else '-':>6}")

    if sweep:
        print("\n=== 时序稳定性推演（同一城市在不同时刻查看）===")
        for c, lat, lng, wx, _ in rows[:3]:
            print(f"\n【{c}】")
            print(f"  {'查看时刻':<18}{'相关':>5}{'过程':>7}{'已下':>7}{'待下':>7}{'档':>3}{'阶段':>8}")
            for dh in (-36, -24, -12, 0, 12, 24, 36):
                ep = now + dh * 3600
                tab = {"_city": pct_all.get(c)}
                r = assess(lat, lng, pts, fc, wx, ep, tab)
                ts = datetime.fromtimestamp(ep, BJT).strftime("%m-%d %H:%M")
                mark = " ←现在" if dh == 0 else ""
                print(f"  {ts:<18}{'是' if r['relevant'] else '否':>5}{r['rain']:6d}mm"
                      f"{r['past']:6d}mm{r['future']:6d}mm{r['level']:3d}{r['phase']:>9}{mark}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
