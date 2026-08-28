/* AssessCore — 台风影响评估的纯函数核心（全站唯一的一把尺子）。

   为什么抽出来：此前校准脚本(sanity_check.py)是 assess() 的 Python 平行复刻，
   同步过五次仍有漂移（如 Pa 公式最近一天权重 panel 用 K¹、脚本用 K⁰）——验收工具
   与被验收对象是两套实现，验收本身不可信。现在前端(panel.js)与校准脚本
   (scripts/sanity_check.mjs)共用本文件。

   铁律：本文件内 **无 DOM、无 fetch、无 Date.now()**——「现在」永远是 nowT 参数
   （这也是事件时间线层 Phase B 的地基：同一函数注入不同时刻即得整条时间线）。
   estGaleRadius 表仍留在 data.js（全站唯一权威表，build_impact.py 解析它），
   由调用方 configure() 注入，不在此复制。

   判定口径本身零改动——本文件是 panel.js 原 assess()/localImpactTier() 及其
   几何辅助的逐行搬移，行为与 v88 完全一致（迁移验收见 CHANGELOG）。
   口径说明见 METHODOLOGY.md；改判定请同步 METHODOLOGY 与 CHANGELOG。 */
const AssessCore = (() => {
  const SLOW_KMH = 10;
  const STALL_HOURS = 24;
  // 前期影响雨量法（官方山洪/地质灾害预警口径）：Pa=Σ Kⁱ·P，K 日退水系数；
  // 土壤饱和度 w=min(1,Pa/Wm)，Wm 为土壤最大蓄水量。用于「动态临界雨量」——土越湿门槛越低。
  const SOIL_K = 0.85, WM_SOIL_MM = 100, SOIL_DROP = 0.4;

  let cfg = { estGaleRadius: null };
  function configure(opts) {
    if (opts && typeof opts.estGaleRadius === "function") cfg.estGaleRadius = opts.estGaleRadius;
  }
  function estGale(power) {
    if (!cfg.estGaleRadius) throw new Error("AssessCore 未 configure：estGaleRadius 需从 data.js 注入（全站唯一权威表）");
    return cfg.estGaleRadius(power);
  }

  /* ---------- 几何与时间 ---------- */

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371, d = Math.PI / 180;
    const dLat = (lat2 - lat1) * d, dLng = (lng2 - lng1) * d;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function maxRadius(p) { return p && p.r7 ? Math.max(...p.r7) : null; }

  /* 强度自适应影响半径(km)：有真实 7 级风圈就用，否则按该点强度估计。
     台风会随预报路径减弱——14 级时影响可及几百公里，减弱到 8 级、残涡时该大幅收窄，
     不能全程套用最近一次强台风的陈旧风圈（否则几百公里外的弱残涡也误报「靠近」）。
     估算表在 data.js（全站唯一权威来源，与地图风圈共用）。 */
  function warnRadius(p) {
    return maxRadius(p) || estGale(p && p.power);
  }

  /* 降雨相关半径(km)：**风的范围 ≠ 雨的范围**。7 级风圈衡量的是风，而台风的螺旋
     雨带向外延伸数百公里（台风水平尺度 500~1000 km）——中心还在数百公里外时，
     外围暴雨可能先到。教训：白海豚（8 级、深入内陆）中心距杭州 257 km，超出
     「风圈160×1.25=200」判「与台风无关」，可杭州正连下三天、累计 186 mm 大暴雨，
     官方同期也把江浙沪划入「危险半圆」。故雨的相关性单独用更大的半径。
     夹在 [300,600]：下限保住弱残涡的强降雨（美莎克教训），上限防止全国都算台风账。

     dirFactor：降水**极不对称**，不是一个圆。白海豚实测——移动方向右前象限
     5 城平均 147mm，左侧 3 城平均仅 11mm（13 倍），且距离完全解释不了（福州
     159km 只 11mm，上海 348km 却 193mm）。文献亦然：强降水位于路径前进方向
     右侧、对流集中在移动方向右前象限（低空急流与水汽输送在右侧更强）。 */
  function rainRadius(p, dirFactor) {
    const base = Math.min(600, Math.max(300, warnRadius(p) * 2.5));
    return dirFactor == null ? base : Math.max(150, base * dirFactor);
  }

  /* 方位角：从 (a,b) 看向 (c,d)，0=正北 90=正东 */
  function bearing(a, b, c, d) {
    const p = Math.PI / 180;
    const y = Math.sin((d - b) * p) * Math.cos(c * p);
    const x = Math.cos(a * p) * Math.sin(c * p) - Math.sin(a * p) * Math.cos(c * p) * Math.cos((d - b) * p);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /* 台风在某时刻的移动方向：取该时刻前后最近的两个轨迹点 */
  function moveBearingAt(seq, targetEp) {
    let prev = null, next = null;
    for (const p of seq) {
      const t = ptime(p);
      if (t <= targetEp) prev = p;
      else { next = p; break; }
    }
    const a = prev || seq[0], b = next || seq[seq.length - 1];
    if (!a || !b || a === b) return null;
    return bearing(a.lat, a.lng, b.lat, b.lng);
  }

  /* 降水不对称的方向因子：相对移动方向的右前(≈45°)最大、左后最小 */
  function rainDirFactor(seq, closest, loc) {
    const mv = moveBearingAt(seq, ptime(closest));
    if (mv == null) return null;
    const toMe = bearing(closest.lat, closest.lng, loc.lat, loc.lng);
    const rel = (((toMe - mv) % 360) + 360) % 360;
    return 0.65 + 0.35 * Math.cos((rel - 45) * Math.PI / 180);
  }

  /* 数据时间均为北京时间：显式按 +08:00 解析，海外环境也能与 nowT 正确比较 */
  function ptime(p) { return new Date(p.time.replace(" ", "T") + "+08:00").getTime(); }

  /* ---------- 土壤湿度（前期影响雨量 Pa） ---------- */

  /* 输入：过去 N 天的逐日降水序列（不含今天，最后一个元素=昨天）。
     口径与 panel 一贯行为一致：最近一天权重 K¹、最早一天 Kⁿ。
     （迁移前校准脚本曾用 K⁰ 起——两套尺子第五处，自此统一。） */
  function soilFromDaily(anteSeries) {
    const ante = (anteSeries || []).map((x) => x || 0);
    const sum14 = Math.round(ante.reduce((a, b) => a + b, 0));
    let pa = 0; const n = ante.length;
    for (let i = 0; i < n; i++) pa += Math.pow(SOIL_K, n - i) * ante[i];
    pa = Math.round(pa);
    const w = Math.min(1, pa / WM_SOIL_MM);
    return { sum14, pa, w };
  }

  /* ---------- 影响分档（过境后善后措辞用） ---------- */

  /* 本地实际影响分档（1 外围掠过·轻微 / 2 明显影响 / 3 正面重创）。
     锚在国标：风臂用台风预警信号风级（阵风10级=黄「较重」→2档，12级=橙「严重」→3档）；
     雨臂用降水量等级/暴雨预警（暴雨50→2档，大暴雨100→3档），并按「动态临界雨量」随土壤饱和度下调
     ——土越湿门槛越低（前期影响雨量法）。残余降雨只有与台风相关时才计入，避免普通梅雨顶档。 */
  function localImpactTier(a) {
    const g = a.peakGust ? a.peakGust.v : 0;         // 峰值阵风 km/h
    const w = a.soilW || 0;                          // 土壤饱和度 0..1
    const thr2 = 50 * (1 - SOIL_DROP * w);           // 明显影响：暴雨基准，湿土下调
    const thr3 = 100 * (1 - SOIL_DROP * w);          // 正面重创：大暴雨基准，湿土下调
    // 过程雨量 与「相关的」未来24h残余雨 取大者
    const r = Math.max(a.rain || 0, a.relevant ? (a.postRain24 || 0) : 0);
    if (r >= thr3 || g >= 118 /* 阵风12级·橙 */) return 3;
    if (r >= thr2 || g >= 89 /* 阵风10级·黄 */) return 2;
    return 1;
  }

  /* ---------- 主评估 ---------- */

  /* 输入（全部显式传入，无隐式状态）：
       loc   : {lat,lng} 用户位置
       storm : {track:[...], forecasts:{机构:{points:[...]}}} 台风（data.js 规范化后的形状）
       fdata : {t:[毫秒], ts:[ISO字符串], p:[mm/h], g:[km/h], cur:{rain,gust}|null} 本地逐时模式序列；可空
       soilW : 0..1 土壤饱和度（soilFromDaily 的 w）
       obs   : nearestObs 结果（METAR 实测）或 null
       nowT  : 「现在」的毫秒时间戳——评估的一切时间判断都以它为准 */
  function assess(input) {
    const { loc, storm: s, fdata, soilW = 0, obs = null, nowT } = input;
    const fc = s.forecasts["中国"] || Object.values(s.forecasts)[0];
    const path = s.track.slice(-4).concat(fc ? fc.points : [])
      .map((p) => ({ ...p, dist: haversine(loc.lat, loc.lng, p.lat, p.lng) }));

    const fwdClosest = path.reduce((a, b) => (b.dist < a.dist ? b : a));
    // 全轨迹历史最近点：只看「近4实况+预报」会漏掉几小时前已从你身边掠过、现正远离的城市
    // ——温州（登陆点）、杭州这类，台风北上后近4点已在数百公里外，会被误判「路径不经过」。
    let histClosest = fwdClosest;
    for (let i = 0; i < s.track.length; i++) {
      const hd = haversine(loc.lat, loc.lng, s.track[i].lat, s.track[i].lng);
      if (hd < histClosest.dist) histClosest = { ...s.track[i], dist: hd };
    }
    // 历史最近点更近且已成过去 = 台风已从你身边过去，用它作真实最近点（锚定风雨窗/距离/阶段）
    const closest = (histClosest !== fwdClosest && ptime(histClosest) < nowT) ? histClosest : fwdClosest;
    // 当前 7 级风圈：最近 5 个实况点内的真实半径优先；官方停发（系统减弱）时
    // 按当前强度估算——与地图风圈同一逻辑，分享卡也用它，不再出现陈旧大圈
    let galeR = null, galeREst = false;
    for (let i = s.track.length - 1; i >= Math.max(0, s.track.length - 5); i--) {
      const r = maxRadius(s.track[i]);
      if (r) { galeR = r; break; }
    }
    if (!galeR) {
      galeR = estGale(s.track[s.track.length - 1].power);
      galeREst = true;
    }
    const inRange = path.filter((p) => p.dist < warnRadius(p));

    const pts = fc ? fc.points : [];
    let moveKmh = null;
    if (pts.length > 1) {
      let km = 0, h = 0;
      for (let i = 1; i < pts.length; i++) {
        km += haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
        h += (ptime(pts[i]) - ptime(pts[i - 1])) / 3.6e6;
      }
      if (h > 0) moveKmh = km / h;
    }
    const slowMover = moveKmh !== null && moveKmh < SLOW_KMH;

    let durationH = null, endPoint = null, stillInRangeAtEnd = false;
    if (inRange.length) {
      durationH = (ptime(inRange[inRange.length - 1]) - ptime(inRange[0])) / 3.6e6;
      const after = path.filter((p) => ptime(p) > ptime(closest));
      endPoint = after.find((p) => p.dist >= warnRadius(p)) || null;
      stillInRangeAtEnd = !endPoint && path[path.length - 1].dist < warnRadius(path[path.length - 1]);
    }

    // 本地天气窗口：直接用数值模式逐小时序列判定「风雨何时开始/结束」。
    // 外围雨带常远早于风圈几何（巴威在温州提前8小时）——几何窗口只作模式缺失时的回退。
    let win = null; // {startT,endT,startTs,endTs,src,open}
    if (inRange.length) {
      const endP = endPoint || inRange[inRange.length - 1];
      win = { startT: ptime(inRange[0]), endT: ptime(endP),
              startTs: inRange[0].time, endTs: endP.time,
              src: "几何", open: !endPoint && stillInRangeAtEnd };
    }
    // 相关性门槛：用「降雨相关半径」而非风圈（外围雨带比风圈远得多，杭州教训），
    // 并按降水不对称做方向订正（右前象限放大、左后收窄，白海豚实测 13 倍差）
    const dirF = rainDirFactor(s.track.concat(fc ? fc.points : []), closest, loc);
    const relevant = inRange.length > 0 || closest.dist <= rainRadius(closest, dirF);
    let rain, rainPast = null, rainFuture = null, rainSrc = "演示估算", peakRain = null, peakGust = null;
    if (fdata && !relevant) {
      rain = 0;
      rainSrc = "模式预报";
      win = null;
    } else if (fdata) {
      // 门槛：≥1.5mm/h 的实质降雨或≥8级阵风才算「台风风雨」；
      // 间断>6小时即分段，只取包含台风最近时刻的那段——把梅雨和事后零星降雨排除在归因外
      const RAIN_ON = 1.5, GUST_ON = 62, GAP_H = 6;
      const anchor = ptime(closest);
      const lo = anchor - 36 * 3.6e6, hi = anchor + 48 * 3.6e6;
      const segs = [];
      let cur = null;
      for (let i = 0; i < fdata.t.length; i++) {
        if (fdata.t[i] < lo || fdata.t[i] > hi) continue;
        if ((fdata.p[i] || 0) >= RAIN_ON || (fdata.g[i] || 0) >= GUST_ON) {
          if (cur && fdata.t[i] - fdata.t[cur.iL] > GAP_H * 3.6e6) { segs.push(cur); cur = null; }
          if (!cur) cur = { iF: i, iL: i };
          else cur.iL = i;
        }
      }
      if (cur) segs.push(cur);
      // 选包含 anchor 的段；都不包含则选离 anchor 最近的
      let seg = segs.find((sg) => fdata.t[sg.iF] <= anchor && anchor <= fdata.t[sg.iL] + GAP_H * 3.6e6);
      if (!seg && segs.length) {
        seg = segs.reduce((a2, b2) =>
          Math.min(Math.abs(fdata.t[a2.iF] - anchor), Math.abs(fdata.t[a2.iL] - anchor)) <
          Math.min(Math.abs(fdata.t[b2.iF] - anchor), Math.abs(fdata.t[b2.iL] - anchor)) ? a2 : b2);
      }
      const iF = seg ? seg.iF : -1, iL = seg ? seg.iL : -1;
      rain = 0;
      if (iF >= 0) {
        win = { startT: fdata.t[iF], endT: fdata.t[iL],
                startTs: fdata.ts[iF].replace("T", " ") + ":00",
                endTs: fdata.ts[iL].replace("T", " ") + ":00",
                src: "模式", open: iL >= fdata.t.length - 2 };
        // 已发生 / 未来 分开累计：预警要回答「接下来还有多少」，而已下过的是既成
        // 事实、不该被改写（同一场台风昨天说 186mm、今天说 0mm 的不稳定根源）
        rainPast = 0; rainFuture = 0;
        for (let i = iF; i <= iL; i++) {
          const v = fdata.p[i] || 0;
          rain += v;
          if (fdata.t[i] <= nowT) rainPast += v; else rainFuture += v;
          if (!peakRain || (fdata.p[i] || 0) > peakRain.v) peakRain = { ts: fdata.ts[i], v: fdata.p[i] || 0 };
          if (!peakGust || (fdata.g[i] || 0) > peakGust.v) peakGust = { ts: fdata.ts[i], v: fdata.g[i] || 0 };
        }
        rainPast = Math.round(rainPast); rainFuture = Math.round(rainFuture);
      }
      rain = Math.round(rain);
      rainSrc = "模式预报";
      if (peakRain && peakRain.v < 1) peakRain = null;
      if (peakGust && peakGust.v < 40) peakGust = null;
    } else {
      rain = closest.dist < 80 ? 260 : closest.dist < 150 ? 180
        : closest.dist < 250 ? 100 : closest.dist < 400 ? 50 : 15;
      if (slowMover) rain = Math.round(rain * 1.6);
    }

    const power = parseInt(closest.power) || 0;
    const wr = warnRadius(closest);
    // 风险档的雨臂与 localImpactTier 同口径：同样的雨，土越湿越危险、致灾门槛越低。
    // 原先 level 用固定 60/150/250、tier 却用动态阈值——两套尺子。后果：杭州连下
    // 三天土壤已饱和，只因未来预报下调让总量跨回 150 以下就降档，可台风还在影响中。
    const wet = 1 - SOIL_DROP * soilW;
    let level = 1;
    // 雨臂：随土壤湿度动态下调
    if (rain >= 60 * wet) level = 2;
    if (rain >= 150 * wet) level = 3;
    // 「高危」的文案涉及听从转移安排，门槛不随土壤湿度下调——湿土提前进入戒备是
    // 合理的，但把整片长三角推到转移级别就过度了（土壤饱和时 187mm 也会触发）。
    if (rain >= 250) level = 4;
    /* 风臂：**用本地实际预报的峰值阵风**，对齐《台风预警信号》风级，而不是拿
       「中心距离 + 中心强度」当代理。巴威教训：它是 10~13 级、浙江各市都在 200km
       内，几何代理把 8 城全判「戒备」——可实测峰值阵风只有 8~9 级、嘉兴雨量仅
       23.5mm。中心多强 ≠ 你这里多大风，这是系统性的过度预警。 */
    const pgust = peakGust ? peakGust.v : null;
    if (pgust !== null) {
      if (pgust >= 89) level = Math.max(level, 2);    // 阵风10级·黄「较重」
      if (pgust >= 118) level = Math.max(level, 3);   // 阵风12级·橙「严重」
      if (pgust >= 150) level = Math.max(level, 4);   // 阵风14级·红
    } else {
      // 无模式数据时才回退到几何代理（保底，别把没数据当没风险）
      if (closest.dist < wr && power >= 8) level = Math.max(level, 2);
      if (closest.dist < 200 && power >= 10) level = Math.max(level, 3);
    }
    // 安全网在下方——它要看「此刻/未来」的中心，而 cNow 在阶段判定处才算出来
    if (slowMover && closest.dist < wr) level = Math.max(level, 3);

    // 阶段：来之前 / 影响进行中 / 已过境。「过没过境」看台风中心此刻在不在你的影响半径内，
    // 不是看本地雨窗停没停——弱台风贴着你走时雨可能暂歇，但它并没走（青岛市南教训）。
    // 过境 ≠ 结束——残余降雨单独判断（美莎克教训）。
    // 把「近实况 + 预报」时间线插值到 now，得到中心此刻位置、当前距离与趋势
    const centerAt = (t) => {
      const tl = path;
      if (t <= ptime(tl[0])) return tl[0];
      for (let i = 1; i < tl.length; i++) {
        if (t <= ptime(tl[i])) {
          const a = tl[i - 1], b = tl[i], t0 = ptime(a), t1 = ptime(b);
          const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
          return { lat: a.lat + f * (b.lat - a.lat), lng: a.lng + f * (b.lng - a.lng),
                   power: (parseInt(a.power) || 0) + f * ((parseInt(b.power) || 0) - (parseInt(a.power) || 0)) };
        }
      }
      return tl[tl.length - 1];
    };
    const cNow = centerAt(nowT);
    const dNow = haversine(loc.lat, loc.lng, cNow.lat, cNow.lng);
    const cAh = centerAt(nowT + 3 * 3.6e6);
    const dAhead = haversine(loc.lat, loc.lng, cAh.lat, cAh.lng);
    const curRadius = estGale(Math.round(cNow.power)) || wr;
    const centerNear = dNow <= curRadius * 1.5;   // 中心仍在影响半径 1.5 倍内 = 仍在近旁
    const receding = dAhead > dNow + 5;            // 3 小时后更远 = 正在远离
    /* 安全网：强台风正面压境时不放过——模式对极端阵风可能低估。但**只看此刻或未来**，
       不看历史：沙德尔教训——14 级中心从台州 52km 外掠过 7 小时后，中心已远到 199km、
       减弱为 10 级，台州实际只下 31mm、阵风 10 级，却仍被判「高危·听从转移安排」。
       台风最强的那一刻过去了，风险等级就该回落——等级面向「接下来该做什么」。 */
    const strongNow = dNow < 100 && Math.round(cNow.power) >= 14;
    const strongSoon = path.some((p) => ptime(p) >= nowT && p.dist < 100 && (parseInt(p.power) || 0) >= 14);
    if (strongNow || strongSoon) level = Math.max(level, 4);
    let phase = "approach";
    if (win && nowT >= win.startT) {
      const centerGone = !centerNear && receding;       // 中心确已离开影响半径且在远离
      const windowDone = !win.open && nowT > win.endT;   // 本地风雨窗也已结束
      phase = (windowDone && centerGone) ? "after" : "during";
    } else if (!win && relevant && ptime(closest) < nowT) {
      // 兜底：拿不到风雨窗口、但台风最近点确已成为过去 = 这是「已经过去」。
      // 模式序列再长也有尽头，超出回溯范围时绝不能退化成「风雨会来」——
      // 一场台风对一座城市是完整事件，事件的每个时刻都得说对（红霞教训）。
      phase = "after";
    }
    if (win) durationH = (win.endT - win.startT) / 3.6e6;

    // 此刻锚点：机场 METAR 实测优先（真实观测，模式在减弱尾段会高报约一个风级），
    // 无就近站时回退 Open-Meteo：15 分钟级 current 优先，整点槽再回退
    let nowWx = null, easing = false;
    if (obs) {
      nowWx = { rain: obs.rainMm, gust: obs.gustKmh, obs: true,
                rainDesc: obs.rainDesc, distKm: obs.distKm, ageMin: obs.ageMin };
    } else if (fdata) {
      if (fdata.cur && fdata.cur.rain != null) {
        nowWx = { rain: fdata.cur.rain, gust: fdata.cur.gust || 0 };
      } else {
        let iNow = -1;
        for (let i = 0; i < fdata.t.length; i++) if (fdata.t[i] <= nowT) iNow = i;
        if (iNow >= 0) nowWx = { rain: fdata.p[iNow] || 0, gust: fdata.g[iNow] || 0 };
      }
    }
    if (nowWx) {
      // 减弱期：最近点已过（中心在远离）+ 此刻明显弱于本次峰值 或 已降到警戒线下。
      // 不再单纯卡「阵风<62」——台风刚擦过但仍有 8 级时，真相是「已过峰值正在减弱」而非「进行中」
      const pastClosest = ptime(closest) < nowT;
      const gPeak = peakGust ? peakGust.v : 0;
      easing = phase === "during" && pastClosest &&
        ((nowWx.rain < 1.5 && nowWx.gust < 62) || (gPeak > 0 && nowWx.gust <= gPeak * 0.85));
    }
    let postRain24 = null;
    if (fdata) {
      postRain24 = 0;
      for (let i = 0; i < fdata.t.length; i++) {
        if (fdata.t[i] >= nowT && fdata.t[i] <= nowT + 24 * 3.6e6) postRain24 += fdata.p[i] || 0;
      }
      postRain24 = Math.round(postRain24);
    }
    // 已过境或已过峰值减弱中、且残余降雨有限时，档位自然回落——「正在减弱」与「戒备」不该同屏
    if ((phase === "after" || easing) && postRain24 !== null && postRain24 < 30) level = Math.min(level, 2);

    // 远台风趋势：预报期末距离比当前明显拉近 = 正朝你来。
    // 官方预报只有约5天——「现有预报未覆盖到你」≠「不会来」，绝不能提前安抚
    let closing = false, fcEndTs = null;
    if (!win) {
      const lastFix = s.track[s.track.length - 1];
      const nowDist = haversine(loc.lat, loc.lng, lastFix.lat, lastFix.lng);
      // 「正朝你来」还要求最近点相对其（届时）强度确实够近——否则几百公里外掠过的
      // 弱残涡也会误报「靠近中」。强台风放宽到 2.5×影响半径，减弱后自动收窄。
      closing = closest.dist < nowDist - 150 && closest.dist <= warnRadius(closest) * 2.5;
      if (fc && fc.points.length) fcEndTs = fc.points[fc.points.length - 1].time;
    }

    /* 两条**不同**的危险轴，别混为一谈：

       A. 停留型（slowThreat）＝ 台风本身赖着不走。判据：中心进你的影响半径（挡住
          远洋新生慢台风，海神教训）+ 移速真慢 <10km/h（挡住常速台风，荔湾教训）
          + 过程雨量达暴雨级（只讲慢不讲累积，等于把「慢」本身当危险）。

       B. 持续性降雨（longRain）＝ **你这里的雨要下很久**，与台风快慢无关。白海豚
          教训：移速 17.5~36km/h 一点不慢，可上海风雨持续 52 小时、累计 208mm，
          别墅负一楼与临街商铺进水。对比巴威——中心更近、阵风更大，实质降雨却只有
          4 小时，平均雨强反而更高（5.9 vs 4.5 mm/h），过程雨量仅 23.5mm。
          **差别几乎全在「下了多久」**：排水扛得住短时强降雨，扛不住连续两天不停。

       用户关心的是「雨要下多久」，不是「台风移速多少」——移速只是中间原因。故把 B
       独立成一条提示，而不是硬塞进「停留型」那个标签（36km/h 却叫停留型会让人困惑）。*/
    const accumHeavy = rain >= 50 * wet;
    const slowThreat = closest.dist < wr && slowMover && accumHeavy;
    const longRain = relevant && durationH !== null && durationH >= STALL_HOURS && accumHeavy;

    return { closest, galeR, galeREst, inRange, win, rain, rainPast, rainFuture, rainSrc,
             peakRain, peakGust, phase, postRain24,
             nowWx, easing, closing, fcEndTs, relevant, soilW, dNow, centerNear,
             level, moveKmh, slowMover, slowThreat, longRain, durationH, endPoint, stillInRangeAtEnd };
  }

  return { configure, assess, localImpactTier, soilFromDaily,
           haversine, bearing, ptime, maxRadius, warnRadius, rainRadius,
           SLOW_KMH, STALL_HOURS, SOIL_K, WM_SOIL_MM, SOIL_DROP };
})();
if (typeof module !== "undefined" && module.exports) module.exports = AssessCore;
