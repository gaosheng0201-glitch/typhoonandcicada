/* ImpactPanel — 底部「我会不会受灾」分步向导。
   步骤：地区 → 人群 → 环境 → 结果；已设置过的用户折叠为迷你摘要条。
   评估是全局的：我的位置 × 所有台风/残涡，取最危险系统定档。 */
const ImpactPanel = (() => {
  // 停留型判据：西北太平洋台风常态移速 15~20km/h（快的 30），真正「移动缓慢」是 5~10km/h
  // （海葵登陆后 5-10、烟花平均<10）。原 18km/h 卡在常态区间中段，几乎人人中招——收到 10。
  // 更本质的判据是「在你附近待多久」：移速快但路径贴着你走，照样是长时间碾压。
  const SLOW_KMH = 10;
  const STALL_HOURS = 24;
  // 前期影响雨量法（官方山洪/地质灾害预警口径）：Pa=Σ Kⁱ·P，K 日退水系数；
  // 土壤饱和度 w=min(1,Pa/Wm)，Wm 为土壤最大蓄水量。用于「动态临界雨量」——土越湿门槛越低。
  const SOIL_K = 0.85, WM_SOIL_MM = 100, SOIL_DROP = 0.4;

  const LEVELS = {
    1: { name: "关注", tip: "留意后续预报即可" },
    2: { name: "准备", tip: "今天完成物资检查" },
    3: { name: "戒备", tip: "减少外出，防内涝停电" },
    4: { name: "高危", tip: "听从官方转移安排" },
  };
  const LV_STYLE = {
    1: { color: "#aaa69f", headline: "预报路径不经过你所在区域", sub: "不必被「超强台风」的标题吓到" },
    2: { color: "#c9a961", headline: "风雨会来，备点吃喝更安心", sub: "影响有限，做基础准备即可" },
    3: { color: "#ea8640", headline: "影响明显，今天完成防台准备", sub: "重点防内涝和停电" },
    4: { color: "#d0442c", headline: "可能严重受灾，紧盯官方通知", sub: "涉及转移请听从政府安排" },
  };

  const P = {
    storms: [],
    focusTfid: null,
    regions: null,
    checklists: null,
    analogs: null,
    loc: { province: "浙江省", city: "温州市", district: "鹿城区", lat: 28.0034, lng: 120.6742 },
    persona: "urban",
    situations: new Set(),
    antecedent: {},
    forecast: {},   // 数值模式逐小时预报（Open-Meteo），按坐标缓存
    coastal: null,  // 沿海/海岛区县 → 外海暴露采样点（build_coastal.py 预存）
    marine: {},     // 外海浪高逐小时（Open-Meteo Marine），按采样点缓存
    setupDone: false,
    open: false,
    step: "region",
  };

  /* ---------- init ---------- */

  async function init() {
    [P.regions, P.checklists, P.analogs, P.history, P.survival] = await Promise.all([
      fetchJSON2("data/regions.json"),
      fetchJSON2(`data/checklists.json?t=${Date.now()}`),
      fetchJSON2(`data/analogs.json?t=${Date.now()}`),
      fetchJSON2("data/history.json").catch(() => null), // 历史档案缺失时降级
      fetchJSON2(`data/survival.json?t=${Date.now()}`).catch(() => null), // 应急手册
    ]);
    P.coastal = await fetchJSON2(`data/coastal.json?t=${Date.now()}`).catch(() => ({})); // 沿海采样表，缺失降级
    P.rainPct = await fetchJSON2("data/rain-percentile.json").catch(() => null);          // 城市历史台风雨量分位表
    P.adcodes = await fetchJSON2("data/adcodes.json").catch(() => ({}));                  // adcode→中文名（同源 DataV）
    P.warnings = await fetchJSON2(`data/warnings.json?t=${Date.now()}`).catch(() => null); // 官方预警生效集，缺失降级
    P.impact = await fetchJSON2(`data/impact.json?t=${Date.now()}`).catch(() => null);     // AI 多期会商（FNV3 滞后集合），缺失降级
    P.rainHist = await fetchJSON2("data/rain-history.json").catch(() => null);             // 城市×台风客观降雨底座（官方路径×ERA5），缺失降级
    buildAdcodeIndex();
    restore();
    buildLocSelects();
    buildPersonaChips();
    bindShare();
    document.getElementById("btn-geo").onclick = useMyLocation;
    document.getElementById("dock-bar").onclick = () => setOpen(!P.open);
    document.querySelectorAll(".wiz-next, .wiz-back").forEach((b) => {
      b.onclick = () => gotoStep(b.dataset.to);
    });
    loadAntecedent();
    loadForecast();
    loadMarine();
    loadMetar();
    if (P.setupDone) P.step = "result";
    showStep(P.step);
    renderBar();
  }

  function updateAll(storms) {
    P.storms = (storms || []).filter((s) => s && s.track && s.track.length);
    if (P.regions) { loadForecast(); loadMetar(); } // 保持「此刻」新鲜
    renderBar();
    renderResult();
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem("ti_loc"));
      if (saved && P.regions[saved.province]) P.loc = saved;
      const persona = localStorage.getItem("ti_persona");
      if (persona) P.persona = persona;
      P.situations = new Set(JSON.parse(localStorage.getItem("ti_sits") || "[]"));
      P.setupDone = localStorage.getItem("ti_setup") === "1";
    } catch (e) { /* 忽略损坏的本地存储 */ }
  }

  function persist() {
    localStorage.setItem("ti_loc", JSON.stringify(P.loc));
    localStorage.setItem("ti_persona", P.persona);
    localStorage.setItem("ti_sits", JSON.stringify([...P.situations]));
    if (P.setupDone) localStorage.setItem("ti_setup", "1");
  }

  /* ---------- 向导流转 ---------- */

  function setOpen(open) {
    P.open = open;
    document.getElementById("impact-dock").classList.toggle("open", open);
    document.getElementById("dock-body").hidden = !open;
    if (open) showStep(P.step);
    renderBar();
  }

  function gotoStep(step) {
    // 人群无环境可选时跳过第 3 步
    if (step === "sit") {
      const cur = P.checklists.personas.find((p) => p.id === P.persona);
      if (!cur || !cur.situations || !cur.situations.length) step = "result";
    }
    if (step === "result") {
      const first = !P.setupDone;
      P.setupDone = true; persist();
      // 首次完成设置：此刻起才在地图上标出「你」
      if (first && window.onUserLoc) window.onUserLoc(P.loc.lat, P.loc.lng, locLabel());
    }
    P.step = step;
    showStep(step);
  }

  function showStep(step) {
    for (const s of ["region", "persona", "sit", "result"]) {
      document.getElementById(`step-${s}`).hidden = s !== step;
    }
    if (step === "result") renderResult();
  }

  function renderBar() {
    const bar = document.getElementById("dock-bar");
    if (!bar) return;
    if (P.open) {
      bar.innerHTML = `<span>我会不会受灾</span><span class="bar-right">收起</span>`;
      return;
    }
    if (!P.setupDone || !P.regions) {
      bar.innerHTML = `<span>我会不会受灾？</span><span class="bar-right" style="color:#ea8640">30 秒告诉你 →</span>`;
      return;
    }
    if (!P.storms.length) {
      bar.innerHTML = `<span>${locLabel()}</span><span class="bar-right">当前无活跃台风</span>`;
      return;
    }
    const { results } = assessAll();
    const top = results[0];
    const lv = LEVELS[top.a.level];
    const color = LV_STYLE[top.a.level].color;
    const brief = top.a.phase === "during" ? (top.a.easing ? " · 已过峰值，减弱中" : " · 影响进行中")
      : top.a.phase === "after" ? (top.a.relevant && top.a.postRain24 >= 30 ? " · 已过境，雨未停" : " · 已过境")
      : top.a.win && !top.a.win.open ? ` · ${fmtTime(top.a.win.endTs)}结束`
      : top.a.closing ? " · 靠近中，待观察" : "";
    bar.innerHTML = `
      <span>${locLabel()} · <span class="mini-lv" style="color:${color}">${lv.name}</span></span>
      <span class="bar-right">${top.s.name}${results.length > 1 ? ` 等${results.length}系统` : ""}${brief}</span>`;
  }

  /* ---------- 位置选择 ---------- */

  function buildLocSelects() {
    const sp = document.getElementById("sel-prov");
    sp.innerHTML = Object.keys(P.regions)
      .map((n) => `<option ${n === P.loc.province ? "selected" : ""}>${n}</option>`).join("");
    sp.onchange = () => { P.loc.province = sp.value; P.loc.city = null; P.loc.district = null; syncCitySelect(); };
    syncCitySelect(true);
  }

  function syncCitySelect(keep = false) {
    const cities = P.regions[P.loc.province].cities;
    const names = Object.keys(cities);
    if (!keep || !names.includes(P.loc.city)) P.loc.city = names[0] || null;
    const sc = document.getElementById("sel-city");
    sc.innerHTML = names.map((n) => `<option ${n === P.loc.city ? "selected" : ""}>${n}</option>`).join("");
    sc.onchange = () => { P.loc.city = sc.value; P.loc.district = null; syncDistrictSelect(); };
    syncDistrictSelect(keep);
  }

  function syncDistrictSelect(keep = false) {
    const cityNode = P.regions[P.loc.province].cities[P.loc.city] || { districts: {} };
    const names = Object.keys(cityNode.districts || {});
    const sd = document.getElementById("sel-dist");
    sd.style.display = names.length ? "" : "none";
    if (!keep || !names.includes(P.loc.district)) P.loc.district = names[0] || null;
    sd.innerHTML = names.map((n) => `<option ${n === P.loc.district ? "selected" : ""}>${n}</option>`).join("");
    sd.onchange = () => { P.loc.district = sd.value; applyLoc(); };
    applyLoc();
  }

  function applyLoc() {
    const prov = P.regions[P.loc.province];
    const cityNode = prov.cities[P.loc.city];
    if (P.loc.district && cityNode && cityNode.districts[P.loc.district]) {
      [P.loc.lat, P.loc.lng] = cityNode.districts[P.loc.district];
    } else if (cityNode) {
      P.loc.lat = cityNode.lat; P.loc.lng = cityNode.lng;
    } else {
      P.loc.lat = prov.lat; P.loc.lng = prov.lng;
    }
    persist();
    loadAntecedent();
    loadForecast();
    loadMarine();
    renderBar();
    renderResult();
    // 通知地图更新「你」的位置标记——仅在用户真正设过位置后，避免首访者看到默认温州被标「你」
    if (window.onUserLoc && P.setupDone) window.onUserLoc(P.loc.lat, P.loc.lng, locLabel());
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    const btn = document.getElementById("btn-geo");
    btn.textContent = "…";
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      let best = null, bestD = Infinity;
      for (const [pn, prov] of Object.entries(P.regions)) {
        for (const [cn, city] of Object.entries(prov.cities)) {
          const dists = Object.entries(city.districts || {});
          for (const [dn, [dlat, dlng]] of dists) {
            const d = haversine(lat, lng, dlat, dlng);
            if (d < bestD) { bestD = d; best = { province: pn, city: cn, district: dn, lat: dlat, lng: dlng }; }
          }
          if (!dists.length) {
            const d = haversine(lat, lng, city.lat, city.lng);
            if (d < bestD) { bestD = d; best = { province: pn, city: cn, district: null, lat: city.lat, lng: city.lng }; }
          }
        }
      }
      btn.textContent = "定位";
      if (best && bestD < 300) {
        P.loc = best;
        buildLocSelects();
      }
    }, () => { btn.textContent = "定位"; });
  }

  function locLabel() {
    return P.loc.district || P.loc.city || P.loc.province;
  }

  /* ---------- 官方预警（中国气象局，经 WMO 公开中继） ---------- */

  // adcode 编码层级：省 xx0000 / 市州 xxyy00 / 区县 其它。据此建「名字→adcode」索引消歧。
  function buildAdcodeIndex() {
    const idx = { prov: {}, byName: {} };
    for (const [ad, name] of Object.entries(P.adcodes || {})) {
      if (ad.length !== 6) continue;
      if (ad.endsWith("0000")) idx.prov[name] = ad.slice(0, 2); // 省名→2位前缀
      (idx.byName[name] = idx.byName[name] || []).push(ad);
    }
    P.adcodeIdx = idx;
  }

  // 由用户选择（省/市/区县名）解析出 adcode——用省前缀 + 层级位约束消歧
  function resolveAdcode() {
    const idx = P.adcodeIdx;
    if (!idx) return null;
    const pp = idx.prov[P.loc.province];
    if (!pp) return null;
    const pick = (name, kind) => {
      const cands = (idx.byName[name] || []).filter((ad) => ad.startsWith(pp) &&
        (kind === "dist" ? !ad.endsWith("00") : ad.endsWith("00") && !ad.endsWith("0000")));
      return cands[0] || null;
    };
    if (P.loc.district) return pick(P.loc.district, "dist") || pick(P.loc.city, "city");
    if (P.loc.city) return pick(P.loc.city, "city");
    return pp + "0000";
  }

  const WARN_COLOR = { "蓝色": "#3b82c4", "黄色": "#d8b23a", "橙色": "#e0803c", "红色": "#d0442c" };
  const WARN_RANK = { "红色": 4, "橙色": 3, "黄色": 2, "蓝色": 1, "": 0 };

  // 匹配用户所在地的生效官方预警：本区县 + 上级市 + 省，按等级去重排序
  function officialWarnings() {
    if (!P.warnings || !P.warnings.warnings) return [];
    const ad = resolveAdcode();
    if (!ad) return [];
    const keys = [ad, ad.slice(0, 4) + "00", ad.slice(0, 2) + "0000"];
    const seen = new Set(), out = [];
    for (const k of keys) {
      for (const w of (P.warnings.warnings[k] || [])) {
        const sig = w.type + w.color;
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(w);
      }
    }
    out.sort((a, b) => (WARN_RANK[b.color] || 0) - (WARN_RANK[a.color] || 0));
    return out;
  }

  function warnExpiry(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const mm = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0"), mi = String(d.getMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  // 官方预警合并成一个与台风同级的独立胶囊（颜色取最高级别）——有台风时用户自然
  // 关联，没有时就是一条独立警告。点开列出各条：类型、级别、时效。只转达、不归因。
  function officialChipsHtml() {
    const ws = officialWarnings();
    P._ow = ws;
    if (!ws.length) return "";
    const c = WARN_COLOR[ws[0].color] || "#8a8";   // ws 已按级别降序，取最高
    return `<div class="storm-chips ow-chips"><button class="chip storm-chip ow-chip" style="--owc:${c}">官方预警</button></div><div class="ow-detail" hidden></div>`;
  }
  function warnTime(w) {
    if (w.expires) return "有效至 " + warnExpiry(w.expires);
    if (w.issued) return "发布 " + warnExpiry(w.issued);
    return "";
  }

  /* ---------- 人群与环境 ---------- */

  function buildPersonaChips() {
    const el = document.getElementById("persona-row");
    el.innerHTML = P.checklists.personas.map((p) =>
      `<button class="chip ${p.id === P.persona ? "on" : ""}" data-p="${p.id}">${p.name}</button>`
    ).join("");
    el.querySelectorAll(".chip").forEach((b) => {
      b.onclick = () => {
        P.persona = b.dataset.p; P.situations.clear(); persist(); buildPersonaChips();
        if (P.step === "result") renderResult(); // 结果页改人群，清单实时跟着换
      };
    });
    buildSituationRow();
  }

  function buildSituationRow() {
    const cur = P.checklists.personas.find((p) => p.id === P.persona);
    const sits = (cur && cur.situations) || [];
    const sitEl = document.getElementById("situation-row");
    sitEl.innerHTML = sits.length
      ? sits.map((s) =>
        `<label class="sit"><input type="checkbox" data-s="${s.id}" ${P.situations.has(s.id) ? "checked" : ""}>${s.name}</label>`
      ).join("")
      : `<span class="sit-none">该人群无需额外选择，直接查看结果即可</span>`;
    sitEl.querySelectorAll("input").forEach((i) => {
      i.onchange = () => {
        i.checked ? P.situations.add(i.dataset.s) : P.situations.delete(i.dataset.s); persist();
        if (P.step === "result") renderResult();
      };
    });
  }

  function checklistItems(level) {
    const lists = P.checklists.items;
    const pick = (obj) => { for (let l = level; l >= 1; l--) if (obj && obj[l]) return obj[l]; return []; };
    let items = pick(lists[P.persona]).slice();
    if (P.persona === "urban") for (const s of P.situations) items = items.concat(pick(lists[s]));
    return items;
  }

  /* 按阶段选清单：远方靠近=出行与安排，来之前=备灾（人群×等级），
     进行中=避险，过境后=恢复期（含人群补充） */
  function phaseChecklist(a) {
    const ph = P.checklists.phases || {};
    const ex = (k) => (ph[k] || {})[P.persona] || []; // 该人群在某阶段的专属补充
    // 减弱期：峰值已过、风雨在退——过渡清单（避险→恢复的中间态）+ 人群专属
    if (a.phase === "during" && a.easing && ph.easing) {
      return ph.easing.concat(ex("easing_extra"));
    }
    if (a.phase === "during") {
      // 停留型台风：追加「被困数天怎么撑」——项目缘起（美莎克）场景
      const stall = ((a.slowThreat || a.longRain) && ph.during_stall) ? ph.during_stall : [];
      return (ph.during || []).concat(stall, ex("during_extra"));
    }
    if (a.phase === "after") {
      // 按本地「实际」影响强度分 3 档：外围掠过 / 明显影响 / 正面重创
      const tier = localImpactTier(a);
      const base = (tier >= 3 ? ph.after : tier === 2 ? (ph.after_mid || ph.after)
        : (ph.after_light || ph.after)) || [];
      // 人群专属恢复分档各有专属：擦肩而过给「恢复常态」，明显影响给中档善后，
      // 正面重创给完整善后——不拿「排水抢救受淹作物」去套一个田里没进水的农户
      const pex = tier === 1 ? ex("after_light_extra") : tier === 2 ? ex("after_mid_extra") : ex("after_extra");
      return base.concat(pex);
    }
    if (a.phase === "approach") {
      // 风雨还早（>3 天）或只是远处靠近尚无窗口 → 远期跟踪清单（先规划/留意路径/别囤），
      // 绝不上「避免外出、远离广告牌」这类避险项——影响范围还没到、外面还天晴（与标题同口径）
      const leadH = a.win ? (a.win.startT - Date.now()) / 3.6e6 : Infinity;
      if (ph.watch && ((!a.win && a.closing) || leadH > 72)) {
        return ph.watch.concat(ex("watch_extra"));
      }
    }
    return checklistItems(a.level);   // 3 天内：备灾清单（人群×等级）
  }

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

  /* ---------- 评估 ---------- */

  function assess(s) {
    const fc = s.forecasts["中国"] || Object.values(s.forecasts)[0];
    const path = s.track.slice(-4).concat(fc ? fc.points : [])
      .map((p) => ({ ...p, dist: haversine(P.loc.lat, P.loc.lng, p.lat, p.lng) }));

    const fwdClosest = path.reduce((a, b) => (b.dist < a.dist ? b : a));
    // 全轨迹历史最近点：只看「近4实况+预报」会漏掉几小时前已从你身边掠过、现正远离的城市
    // ——温州（登陆点）、杭州这类，台风北上后近4点已在数百公里外，会被误判「路径不经过」。
    let histClosest = fwdClosest;
    for (let i = 0; i < s.track.length; i++) {
      const hd = haversine(P.loc.lat, P.loc.lng, s.track[i].lat, s.track[i].lng);
      if (hd < histClosest.dist) histClosest = { ...s.track[i], dist: hd };
    }
    // 历史最近点更近且已成过去 = 台风已从你身边过去，用它作真实最近点（锚定风雨窗/距离/阶段）
    const closest = (histClosest !== fwdClosest && ptime(histClosest) < Date.now()) ? histClosest : fwdClosest;
    // 当前 7 级风圈：最近 5 个实况点内的真实半径优先；官方停发（系统减弱）时
    // 按当前强度估算——与地图风圈同一逻辑，分享卡也用它，不再出现陈旧大圈
    let galeR = null, galeREst = false;
    for (let i = s.track.length - 1; i >= Math.max(0, s.track.length - 5); i--) {
      const r = maxRadius(s.track[i]);
      if (r) { galeR = r; break; }
    }
    if (!galeR) {
      galeR = TyphoonData.estGaleRadius(s.track[s.track.length - 1].power);
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
    const fdata = P.forecast[`${P.loc.lat},${P.loc.lng}`];
    let win = null; // {startT,endT,startTs,endTs,src,open}
    if (inRange.length) {
      const endP = endPoint || inRange[inRange.length - 1];
      win = { startT: ptime(inRange[0]), endT: ptime(endP),
              startTs: inRange[0].time, endTs: endP.time,
              src: "几何", open: !endPoint && stillInRangeAtEnd };
    }
    // 相关性门槛：用「降雨相关半径」而非风圈（外围雨带比风圈远得多，杭州教训），
    // 并按降水不对称做方向订正（右前象限放大、左后收窄，白海豚实测 13 倍差）
    const dirF = rainDirFactor(s.track.concat(fc ? fc.points : []), closest);
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
        const nowMs = Date.now();
        rainPast = 0; rainFuture = 0;
        for (let i = iF; i <= iL; i++) {
          const v = fdata.p[i] || 0;
          rain += v;
          if (fdata.t[i] <= nowMs) rainPast += v; else rainFuture += v;
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
    const anteRec = P.antecedent[`${P.loc.lat},${P.loc.lng}`];
    const soilW = (anteRec && typeof anteRec === "object") ? anteRec.w : 0;
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
    // 安全网：强台风中心正面压境时不放过——模式对极端阵风可能低估
    if (closest.dist < 100 && power >= 14) level = Math.max(level, 4);
    if (slowMover && closest.dist < wr) level = Math.max(level, 3);

    // 阶段：来之前 / 影响进行中 / 已过境。「过没过境」看台风中心此刻在不在你的影响半径内，
    // 不是看本地雨窗停没停——弱台风贴着你走时雨可能暂歇，但它并没走（青岛市南教训）。
    // 过境 ≠ 结束——残余降雨单独判断（美莎克教训）。
    const nowT = Date.now();
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
    const dNow = haversine(P.loc.lat, P.loc.lng, cNow.lat, cNow.lng);
    const cAh = centerAt(nowT + 3 * 3.6e6);
    const dAhead = haversine(P.loc.lat, P.loc.lng, cAh.lat, cAh.lng);
    const curRadius = TyphoonData.estGaleRadius(Math.round(cNow.power)) || wr;
    const centerNear = dNow <= curRadius * 1.5;   // 中心仍在影响半径 1.5 倍内 = 仍在近旁
    const receding = dAhead > dNow + 5;            // 3 小时后更远 = 正在远离
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
    const obs = nearestObs(P.loc.lat, P.loc.lng);
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
      const nowDist = haversine(P.loc.lat, P.loc.lng, lastFix.lat, lastFix.lng);
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

  /* 此刻天气的人话描述（小时雨强口径：<2.5 小雨 / <8 中雨 / <16 大雨 / ≥16 暴雨强度） */
  function nowWxDesc(w) {
    // 实测（METAR）：观测不给逐时雨量，用观测降水现象的定性描述，不编造 mm/h 数字
    if (w.obs) return `${w.rainDesc} · 阵风约${gustLevel(w.gust)}级`;
    const r = w.rain < 0.1 ? "基本无雨" : w.rain < 2.5 ? "小雨" : w.rain < 8 ? "中雨"
      : w.rain < 16 ? "大雨" : "暴雨强度";
    const num = w.rain >= 0.1 ? `（约 ${Math.round(w.rain * 10) / 10} mm/h）` : "";
    return `${r}${num} · 阵风约${gustLevel(w.gust)}级`;
  }

  /* 阶段化标题：不同阶段说不同的话 */
  function headlineFor(a) {
    if (a.phase === "during") return a.easing ? "风雨已过峰值，正在减弱" : "风雨影响进行中，减少外出";
    if (a.phase === "after") {
      if (a.relevant && a.postRain24 !== null && a.postRain24 >= 30)
        return "台风已过境，但雨还没停——警惕滞后内涝与山洪";
      const tier = localImpactTier(a);
      return tier >= 3 ? "台风已过境，恢复期注意安全"
        : tier === 2 ? "台风已过境，本地受到明显影响，注意善后"
        : "台风已过境，本地以外围影响为主";
    }
    if (!a.win && a.closing) return "台风还远，是否影响你尚无法判断";
    // 来之前（approach）：紧迫程度随「风雨还有多久到」缩放——窗口在 6 天后却喊
    // 「今天完成防台准备」不合理（校准的冷静：别提前几天就催、制造疲劳/狼来了）。
    if (a.win) {
      if (a.level === 1) return "会有些风雨，但影响有限，留意即可";
      const leadH = (a.win.startT - Date.now()) / 3.6e6;
      const impact = a.level >= 4 ? "可能严重受灾" : a.level === 3 ? "预计影响明显" : "预计有影响";
      if (leadH > 72) return `${impact}，但风雨还有约 ${Math.round(leadH / 24)} 天才到——先跟踪路径，暂不用忙`;
      if (leadH > 36) return `${impact}，未来一两天做好防台准备`;
    }
    return LV_STYLE[a.level].headline;   // 临近（≤~1.5 天）或无窗高档：用原紧迫标题
  }

  function assessAll() {
    const results = P.storms.map((s) => ({ s, a: assess(s) }));
    results.sort((x, y) => y.a.level - x.a.level || x.a.closest.dist - y.a.closest.dist);
    const focus = results.find((r) => r.s.tfid === P.focusTfid) || results[0];
    return { results, focus };
  }

  /* 对照严格同城优先：城市自己的历史才编码了它的排水、地形与基建。
     没有本地案例时只做「量级参考」，不做量化对比（异地不可比）。 */
  /* 行政区名规范化：儋州市→儋州、陵水黎族自治县→陵水、湘西…自治州→湘西、屏东县→屏东。
     与 scripts/validate_analogs.py 的规则保持一致。 */
  function canonCity(x) {
    const m = /^(.*?)(?:(?:黎族|苗族|土家族|侗族|仡佬族|各族)*自治[县州]|市|县|地区|盟)$/.exec(x || "");
    return m && m[1] ? m[1] : (x || "");
  }

  function findAnalog(rain, power = 0) {
    const cityShort = canonCity(P.loc.city);
    const local = P.analogs.events.filter((e) =>
      canonCity(e.region.city) === cityShort || e.region.city === P.loc.city);
    if (local.length) {
      // 最强纪录：风力优先，其次影响等级，再次雨量——天花板锚点，永不隐身
      const strongest = local.slice().sort((a, b) =>
        (b.hazard.peakPower || 0) - (a.hazard.peakPower || 0) ||
        (b.impact.level || 0) - (a.impact.level || 0) ||
        (b.hazard.rainTotalMm || 0) - (a.hazard.rainTotalMm || 0))[0];
      // 最相似：来袭为强风型（≥13级）且本地有风力记录 → 按登陆强度匹配；否则按雨量
      if (power >= 13) {
        const withWind = local.filter((e) => e.hazard.peakPower != null);
        if (withWind.length) {
          withWind.sort((a, b) => Math.abs(a.hazard.peakPower - power) - Math.abs(b.hazard.peakPower - power));
          return { analog: withWind[0], local: true, quant: true, mode: "wind", strongest };
        }
      }
      const withRain = local.filter((e) => e.hazard.rainTotalMm != null);
      if (withRain.length) {
        withRain.sort((a, b) => Math.abs(a.hazard.rainTotalMm - rain) - Math.abs(b.hazard.rainTotalMm - rain));
        return { analog: withRain[0], local: true, quant: true, mode: "rain", strongest };
      }
      local.sort((a, b) => (b.impact.level || 0) - (a.impact.level || 0));
      return { analog: local[0], local: true, quant: false, strongest };
    }
    const provShort = (P.loc.province || "").replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, "");
    const rest = P.analogs.events.filter((e) => e.hazard.rainTotalMm != null).sort((a, b) =>
      ((a.region.province.startsWith(provShort) ? 0 : 1) * 10000 + Math.abs(a.hazard.rainTotalMm - rain)) -
      ((b.region.province.startsWith(provShort) ? 0 : 1) * 10000 + Math.abs(b.hazard.rainTotalMm - rain)));
    return { analog: rest[0] || null, local: false, quant: false };
  }

  /* 城市降雨史（rain-history.json：官方路径×ERA5 客观降雨，覆盖远多于叙事库）。
     平静期「你家的台风史」与活跃期无叙事案例时的客观兜底都用它。城市键同源 regions.json。 */
  function cityRainHistory(city) {
    if (!P.rainHist || !P.rainHist.d) return [];
    const out = [];
    for (const tfid in P.rainHist.d) {
      const s = P.rainHist.d[tfid];
      const c = s.cities && s.cities[city];
      if (c) out.push({ tfid, name: s.name, enName: s.enName, year: tfid.slice(0, 4),
                        totalMm: c.totalMm, peakMm: c.peakMm, peakDay: c.peakDay,
                        closestKm: c.closestKm, transit: c.transit });
    }
    // 峰值日雨量优先——最戳破侥幸的是「那天一天下了多少」
    out.sort((a, b) => (b.peakMm || 0) - (a.peakMm || 0));
    return out;
  }

  /* 平静期把 d-analog 变成「你家的台风史」：本地客观档案 + 历次台风降雨 + 叙事记忆。
     只陈列客观量级与生活影响叙事，不作异地量化对比，不涉伤亡。 */
  function renderCityHistory() {
    const box = document.querySelector("#d-analog > div");
    if (!box) return;
    let html = "";
    const hist = P.history &&
      (P.history.d[`${P.loc.province}|${P.loc.city}|${P.loc.district || ""}`] ||
       P.history.d[`${P.loc.province}|${P.loc.city}|`]);
    if (hist) {
      const m = P.history.meta, [c100, c300, month, top] = hist;
      const freq = c100 > 0 ? `，约每 ${Math.max(1, Math.round(m.years / c100))} 年一次` : "";
      html += `<div style="margin-bottom:8px">本地档案 <span class="muted">（${m.source}，${m.since} 年以来）</span><br>
        台风中心 ${m.near_km}km 内经过 <b>${c100}</b> 次${freq}；${m.wide_km}km 内 ${c300} 次，${month} 月最高发</div>`;
    }
    const rain = cityRainHistory(P.loc.city);
    if (rain.length) {
      const rows = rain.slice(0, 6).map((r) =>
        `<div class="tl-row"><span class="t">${r.year}</span><span>${r.name}
          <b>当日峰值约 ${Math.round(r.peakMm)}mm</b><span class="muted">，过程累计约 ${Math.round(r.totalMm)}mm，
          中心最近约 ${r.closestKm}km${r.transit ? "·过境" : ""}</span></span></div>`).join("");
      html += `<div style="border-top:1px solid var(--hairline);padding-top:8px">
        你家的台风史 <span class="muted">（${P.loc.city}，${P.rainHist.meta.source}）</span>${rows}
        <div class="muted" style="margin-top:6px">再分析降雨，仅供感受「台风到你家时是什么量级」，非官方记录。</div></div>`;
    }
    // 有逐字叙事记忆的城市，附最强一条（生活影响，破侥幸）
    const cityShort = canonCity(P.loc.city);
    const local = (P.analogs.events || []).filter((e) =>
      canonCity(e.region.city) === cityShort || e.region.city === P.loc.city);
    if (local.length) {
      const strongest = local.slice().sort((a, b) =>
        (b.hazard.peakPower || 0) - (a.hazard.peakPower || 0) ||
        (b.impact.level || 0) - (a.impact.level || 0) ||
        (b.hazard.rainTotalMm || 0) - (a.hazard.rainTotalMm || 0))[0];
      html += `<div style="border-top:1px solid var(--hairline);margin-top:8px;padding-top:8px">
        本地记忆：<b>${strongest.typhoon.tfid.slice(0, 4)}年${strongest.typhoon.name}</b>
        <div class="quote">${strongest.narrative}</div></div>`;
    }
    if (!html) {
      html = `<span class="muted">${P.loc.city}暂无历史台风降雨记录（该地台风活动较少，或数据尚未覆盖）。</span>`;
    }
    box.innerHTML = html;
  }

  /* ---------- 数值模式预报（逐小时降水与阵风） ---------- */

  async function loadForecast() {
    const key = `${P.loc.lat},${P.loc.lng}`;
    const cached = P.forecast[key];
    if (cached === null) return; // 请求进行中
    if (cached && Date.now() - cached.at < 15 * 60e3) return; // 15 分钟内视为新鲜
    P.forecast[key] = null;
    try {
      const d = await fetchJSON2(
        `https://api.open-meteo.com/v1/forecast?latitude=${P.loc.lat}&longitude=${P.loc.lng}` +
        `&hourly=precipitation,wind_gusts_10m&current=precipitation,wind_gusts_10m` +
        // past_days 要盖住**整个事件周期**：只留 2 天的话，台风过境两天后那段雨会从
        // 序列里滑出，窗口消失 → 半个月前过境的台风竟显示「风雨会来」。取 7 天。
        `&past_days=7&forecast_days=7&timezone=Asia%2FShanghai`);
      P.forecast[key] = {
        at: Date.now(),
        ts: d.hourly.time, // 北京钟面原文，用于展示
        t: d.hourly.time.map((s) => new Date(s + ":00+08:00").getTime()),
        p: d.hourly.precipitation,
        g: d.hourly.wind_gusts_10m,
        // 15 分钟级当前实况——「此刻」必须用它，整点槽可能滞后近一小时
        cur: d.current ? { rain: d.current.precipitation, gust: d.current.wind_gusts_10m } : null,
      };
      renderBar();
      renderResult();
    } catch (e) { delete P.forecast[key]; }
  }

  /* 就近机场 METAR 实测「此刻」：55km 内、报文 150 分钟内才用，否则回退模式 */
  function nearestObs(lat, lng) {
    if (!P.metar || !P.metar.stations || !P.metar.stations.length) return null;
    let best = null, bd = Infinity;
    for (const st of P.metar.stations) {
      if (st.la == null || st.lo == null) continue;
      const d = haversine(lat, lng, st.la, st.lo);
      if (d < bd) { bd = d; best = st; }
    }
    if (!best || bd > 55) return null;
    const age = (Date.now() - new Date(best.t).getTime()) / 60000;
    if (!(age >= 0) || age > 150) return null;
    const gustKt = best.wg != null ? best.wg : (best.ws != null ? best.ws : 0);
    const rainDesc = metarRainDesc(best.wx);
    return {
      gustKmh: Math.round(gustKt * 1.852),   // 节 → km/h
      rainDesc, rainMm: metarRainMm(rainDesc),
      distKm: Math.round(bd), ageMin: Math.round(age),
    };
  }

  /* METAR 天气现象串 → 中文定性降水描述 */
  function metarRainDesc(wx) {
    if (!wx) return "无雨";
    const s = wx.toUpperCase();
    if (!/(RA|DZ|SN|SG|GR|GS|TS|SH|PL|UP)/.test(s)) return "无雨";
    const heavy = s.includes("+"), light = s.includes("-"), thunder = s.includes("TS");
    if (/SN|SG/.test(s)) return heavy ? "大雪" : light ? "小雪" : "中雪";
    if (thunder) return "雷阵雨";
    return heavy ? "大雨" : light ? (s.includes("DZ") ? "毛毛雨" : "小雨") : "中雨";
  }
  /* 给档位/减弱判据用的名义雨强（观测不含 mm/h，取量级代表值） */
  function metarRainMm(desc) {
    if (/大|暴/.test(desc)) return 12;
    if (/中|雷/.test(desc)) return 4;
    if (/小|毛/.test(desc)) return 0.5;
    return 0;
  }

  async function loadMetar() {
    if (P.metar && Date.now() - P.metar.at < 10 * 60e3) return; // 10 分钟内不重复拉
    try {
      const d = await fetchJSON2(`data/metar.json?t=${Date.now()}`);
      d.at = Date.now();
      P.metar = d;
      if (P.step === "result") renderResult(); // 实测到手后刷新「此刻」
    } catch (e) { /* 快照缺失时静默回退模式 */ }
  }

  /* 阵风 km/h → 蒲福风级（近似） */
  function gustLevel(kmh) {
    const ms = kmh / 3.6;
    const t = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37, 41.5, 46.2, 51, 56.1];
    let lv = 0;
    while (lv < t.length && ms >= t[lv]) lv++;
    return lv;
  }

  /* ---------- 前期降雨 ---------- */

  async function loadAntecedent() {
    const key = `${P.loc.lat},${P.loc.lng}`;
    if (P.antecedent[key] !== undefined) return;
    P.antecedent[key] = null;
    try {
      const d = await fetchJSON2(
        `https://api.open-meteo.com/v1/forecast?latitude=${P.loc.lat}&longitude=${P.loc.lng}` +
        `&daily=precipitation_sum&past_days=14&forecast_days=1&timezone=Asia%2FShanghai`);
      const series = (d.daily.precipitation_sum || []).map((x) => x || 0);
      const ante = series.slice(0, -1);          // 去掉今天（预报日），只留前期
      const sum14 = Math.round(ante.reduce((a, b) => a + b, 0));
      // 前期影响雨量 Pa：越近的雨权重越高（Kⁱ 退水），最近一天 K¹，最早一天 K^n
      let pa = 0; const n = ante.length;
      for (let i = 0; i < n; i++) pa += Math.pow(SOIL_K, n - i) * ante[i];
      pa = Math.round(pa);
      const w = Math.min(1, pa / WM_SOIL_MM);    // 土壤饱和度 0..1
      P.antecedent[key] = { sum14, pa, w };
      renderResult();
    } catch (e) { P.antecedent[key] = undefined; }
  }

  /* ---------- 海浪（沿海/海岛）----------
     远处台风的涌浪能杀死海钓、赶海、近海作业的人——本地风雨看着「没事」，海况却危险
     （疯狗浪机制）。沿海地点用预存的外海暴露采样点查浪高，独立于风雨判定。 */
  function seaKey() { return `${Math.round(P.loc.lat * 100)},${Math.round(P.loc.lng * 100)}`; }

  async function loadMarine() {
    if (!P.coastal) return;
    const sea = P.coastal[seaKey()];
    if (!sea) return;                    // 非沿海：无采样点
    const mkey = `${sea[0]},${sea[1]}`;
    const cached = P.marine[mkey];
    if (cached === null) return;         // 请求进行中
    if (cached && Date.now() - cached.at < 15 * 60e3) return;
    P.marine[mkey] = null;
    try {
      const d = await fetchJSON2(
        `https://marine-api.open-meteo.com/v1/marine?latitude=${sea[0]}&longitude=${sea[1]}` +
        `&hourly=wave_height,wave_period,swell_wave_height&past_days=1&forecast_days=3&timezone=Asia%2FShanghai`);
      P.marine[mkey] = {
        at: Date.now(),
        t: d.hourly.time.map((s) => new Date(s + ":00+08:00").getTime()),
        wh: d.hourly.wave_height,
        sw: d.hourly.swell_wave_height,
        wp: d.hourly.wave_period,
        sea,
      };
      renderResult();
    } catch (e) { delete P.marine[mkey]; }
  }

  /* 海浪影响评估：取外海采样点 [now−6h, now+48h] 的峰值有效波高，按浪级 + 官方海浪预警分级。
     返回 null=非沿海/无数据；{none:true}=浪不显著（<2.5m）。 */
  function marineAssess() {
    if (!P.coastal || !P.loc) return null;
    const sea = P.coastal[seaKey()];
    if (!sea) return null;
    const m = P.marine[`${sea[0]},${sea[1]}`];
    if (!m || !m.wh) return null;
    const nowT = Date.now();
    let peak = 0, peakT = null, peakPeriod = 0, cur = null, curSwell = null;
    for (let i = 0; i < m.t.length; i++) {
      if (m.t[i] >= nowT - 6 * 3.6e6 && m.t[i] <= nowT + 48 * 3.6e6) {
        const w = m.wh[i] || 0;
        if (w > peak) { peak = w; peakT = m.t[i]; peakPeriod = m.wp ? (m.wp[i] || 0) : 0; }
      }
      if (cur === null && m.t[i] >= nowT) { cur = m.wh[i] || 0; curSwell = m.sw ? (m.sw[i] || 0) : 0; }
    }
    peak = Math.round(peak * 10) / 10;
    if (peak < 2.5) return { peak, none: true };
    // 浪级（GB/T 波级）：大浪2.5–4 / 巨浪4–6 / 狂浪6–9 / 狂涛≥9
    let tier, name;
    if (peak >= 9) { tier = 4; name = "狂涛"; }
    else if (peak >= 6) { tier = 3; name = "狂浪"; }
    else if (peak >= 4) { tier = 2; name = "巨浪"; }
    else { tier = 1; name = "大浪"; }
    return { peak, peakT, peakPeriod, cur, curSwell, tier, name, sea };
  }

  /* ---------- 结果渲染 ---------- */

  /* AI 多期会商（FNV3 滞后集合，build_impact.py 产出）：
     收敛度=最近几期预报吵不吵架；城市命中=最近 N 期里几期波及本市。
     「还看不准」本身就是要交付的信息，与官方预警并列参考，不替官方下结论。 */
  function aiConsensusHtml(s) {
    if (!P.impact || !P.impact.storms) return "";
    // 新鲜度保护：产出流水线若断更（正常每 6h 一轮），过期结论宁可不说
    if (Date.now() - Date.parse(P.impact.updated) > 24 * 3600e3) return "";
    const st = P.impact.storms.find((x) => x.tfid === s.tfid);
    if (!st || st.stale) return "";
    const CONV = {
      converged: ["#7fae72", "各期已高度一致"],
      converging: ["#d6a94a", "趋于一致"],
      divergent: ["#e0803c", "各期分歧仍大"],
    };
    const conv = st.convergence || {};
    const cv = CONV[conv.state];
    const convLine = cv
      ? `<b style="color:${cv[0]}">${cv[1]}</b>${conv.spreadKm ? `<span class="muted">（近3期路径散布约 ${conv.spreadKm} km）</span>` : ""}${conv.trend > 1.4 ? "，最近几期分歧反而加大" : conv.trend < 0.7 ? "，分歧正在收窄" : ""}`
      : `<span class="muted">${conv.text || "预报期数不足，暂无法评估一致性"}</span>`;
    const city = (st.cities || []).find((x) => x.city === P.loc.city);
    let cityLine;
    if (city) {
      const LV = { high: "#e0625a", medium: "#d6a94a", low: "#8a8578" };
      cityLine = `最近 ${city.of} 期预报中 <b style="color:${LV[city.level]}">${city.hits} 期</b>波及${P.loc.city}` +
        `，${city.window.from} – ${city.window.to} 间最接近` +
        (city.level === "low" ? `<span class="muted">（时效尚远，落点常整体偏移）</span>` : "");
    } else {
      cityLine = `<span class="muted">最近 ${st.runsUsed} 期预报的中心路径均未逼近${P.loc.city}（不排除外围风雨）</span>`;
    }
    return `<div class="ai-consensus">
      <div class="aic-head">AI 多期会商<span class="aic-src">Google FNV3 · 研究性数据 · 以官方为准</span></div>
      <div>${convLine}</div><div>${cityLine}</div></div>`;
  }

  function renderResult() {
    const box = document.getElementById("impact-summary");
    if (!box || P.step !== "result" || !P.regions) return;
    if (!P.storms.length) {
      box.innerHTML = `<div class="lv-badge lv-1"><b>无风</b>当前无活跃台风</div>
        <div class="timebrief">有台风生成时，这里会给出 ${locLabel()} 的风险参考。平静期先看看 ${locLabel()} 经历过的台风——它们真的到过这里。</div>`;
      document.querySelector("#d-timeline > div").innerHTML = "";
      document.querySelector("#d-checklist > div").innerHTML = "";
      renderCityHistory();  // 平静期：把 d-analog 变成「你家的台风史」（客观降雨底座）
      document.getElementById("d-analog").open = true;  // 平静期默认展开，让人先看到自家台风史
      return;
    }

    const { results, focus } = assessAll();
    const s = focus.s, a = focus.a;
    const globalLevel = results[0].a.level;
    const lv = LEVELS[globalLevel];
    const last = s.track[s.track.length - 1];

    const multiRow = results.length > 1
      ? `<div class="storm-chips">${results.map((r) => `
          <button class="chip storm-chip ${r.s.tfid === s.tfid ? "on" : ""}" data-tf="${r.s.tfid}">
            ${r.s.name}${r.s.active === false ? "·残余" : ""}
            <b style="color:${LV_STYLE[r.a.level].color}">${LEVELS[r.a.level].name}</b>
          </button>`).join("")}</div>`
      : "";

    // 预警的主角是「接下来还会怎样」，但**不做「总量−已下＝还剩」的减法**：模式雨量
    // 本身误差大、机构还会不断调整，减出来的「还剩 20mm」是假精度。用户真正需要的是
    // 「影响到哪一步了」——刚开始 / 正猛 / 快结束，这个定性判断稳健得多。
    let aheadBrief = "";
    if (a.relevant && a.win && a.rain > 0 && a.rainPast !== null) {
      const prog = a.rainPast / Math.max(a.rain, 1);
      let txt;
      if (a.phase === "after") txt = "本次风雨影响<b>已基本结束</b>";
      else if (prog < 0.25) txt = "风雨影响<b>刚开始</b>，主要过程还在后面";
      else if (prog < 0.7) txt = a.easing ? "已过最强时段，风雨仍在持续" : "正处在<b>影响较强的时段</b>";
      else txt = "影响<b>已过大半</b>，接近尾声";
      const bg = a.rainPast >= 5 ? `<span class="muted">（本次已下约 ${a.rainPast} mm）</span>` : "";
      aheadBrief = `<div class="timebrief">${txt}${bg}</div>`;
    }

    let timeBrief;
    if (a.win && a.phase === "during") {
      timeBrief = `${fmtTime(a.win.startTs)}已开始${a.win.open ? "，预报期内持续" : `，预计 ${fmtTime(a.win.endTs)}基本结束`}`;
    } else if (a.win && a.phase === "after") {
      timeBrief = `已于 ${fmtTime(a.win.endTs)} 基本结束` +
        (a.postRain24 !== null && a.postRain24 >= 30 ? `，未来24h仍有约 ${a.postRain24} mm 降雨` : "");
    } else if (a.win) {
      timeBrief = `${fmtTime(a.win.startTs)}起风雨${a.win.open ? "，预报期内持续" : `，${fmtTime(a.win.endTs)}结束`}`;
    } else if (a.closing) {
      timeBrief = `正向你的方向移动，现有预报${a.fcEndTs ? `（至 ${fmtTime(a.fcEndTs)}）` : "（约5天）"}尚未覆盖到你——建议每天回来看一眼`;
    } else if (a.closest.dist <= warnRadius(a.closest) * 1.25) {
      timeBrief = `距你最近约 ${Math.round(a.closest.dist)} km，以外围影响为主`;
    } else {
      timeBrief = `台风最近距你约 ${Math.round(a.closest.dist)} km，预计不影响你所在区域`;
    }
    // 海浪危险（沿海/海岛）：独立于风雨——即使判「不经过」，外海涌浪照样致命
    const wave = marineAssess();
    let waveBanner = "";
    if (wave && !wave.none) {
      const wc = ["", "#d6a94a", "#e0803c", "#e0625a", "#d0442c"][wave.tier];
      const act = {
        1: "涌浪会扑上岸边礁石、堤坝——别靠近海边礁石、消浪堤，海钓、赶海暂停",
        2: "近岸涌浪危险——渔船回港、养殖排上岸，远离海边",
        3: "涌浪掀翻小船、漫上岸堤——严禁出海，别去海边看浪、拍浪",
        4: "极危——严禁一切出海与近岸活动，低矮海岸需撤离",
      }[wave.tier];
      const colorNote = wave.peak >= 14 ? "近海海浪红色级" : wave.peak >= 9 ? "近海海浪橙色级"
        : wave.peak >= 6 ? "近海达海浪黄色级" : "";
      waveBanner = `<div class="wave-warn" style="border-left-color:${wc}"><b style="color:${wc}">外海约 ${wave.peak} m ${wave.name}${colorNote ? "（" + colorNote + "）" : ""}</b>：${act}</div>`;
    }
    box.innerHTML = `
      <div class="lv-badge lv-${globalLevel}"><b>${lv.name}</b>风险参考 · ${locLabel()}</div>
      ${results.length > 1 ? `<div class="timebrief" style="margin-top:3px">综合 ${results.length} 个台风/残涡系统的最高风险</div>` : ""}
      ${multiRow}
      ${officialChipsHtml()}
      <div class="headline">${results.length > 1 ? `${s.name}：` : ""}${headlineFor(a)}</div>
      <div class="timebrief">${timeBrief} · 距 ${Math.round(haversine(P.loc.lat, P.loc.lng, last.lat, last.lng))} km</div>
      ${a.nowWx ? `<div class="timebrief">此刻本地：${nowWxDesc(a.nowWx)}<span class="muted">（${a.nowWx.obs ? `最近气象站 ${a.nowWx.distKm}km · ${a.nowWx.ageMin} 分钟前实测` : "模式实况，以体感为准"}）</span></div>` : ""}
      ${aheadBrief}
      ${aiConsensusHtml(s)}
      ${waveBanner}
      ${s.active === false ? `<div class="slow-badge"><b>残余环流</b> —— 已停编，但残涡仍可能强降雨，雨的风险未结束</div>` : ""}
      ${((a.longRain || a.slowThreat) && a.phase !== "after") ? `<div class="slow-badge"><b>风雨持续时间长</b> —— ${
        a.durationH >= 48 ? "预计持续两天以上" : a.durationH ? `预计持续约 ${Math.round(a.durationH)} 小时` : "预计持续偏长"
      }，雨量会不断累积，<b>重点防内涝而不是防风</b>${
        a.slowMover ? `<span class="muted">（台风移动缓慢，约 ${Math.round(a.moveKmh)} km/h）</span>` : ""
      }</div>` : ""}`;
    box.querySelectorAll(".storm-chip").forEach((b) => {
      b.onclick = () => { P.focusTfid = b.dataset.tf; renderResult(); };
    });
    const owBtn = box.querySelector(".ow-chip"), owDetail = box.querySelector(".ow-detail");
    if (owBtn && owDetail) owBtn.onclick = () => {
      const on = owBtn.classList.toggle("on");
      if (!on) { owDetail.hidden = true; return; }
      const rows = (P._ow || []).map((w) => {
        const cc = WARN_COLOR[w.color] || "#8a8", t = warnTime(w);
        return `<div class="ow-item"><i style="background:${cc}"></i>${w.type}${w.color}预警` +
          `<span class="ow-lv">${w.level ? w.level + " 级" : ""}</span>` +
          `${t ? `<span class="ow-exp">${t}</span>` : ""}</div>`;
      }).join("");
      owDetail.innerHTML = rows +
        `<div class="ow-src">来源：中国气象局 · 经 WMO 恶劣天气信息中心公开中继 · 以官方发布为准</div>`;
      owDetail.hidden = false;
    };

    // 时间线（区分已发生/未发生；时间窗来自本地逐时天气序列，几何仅回退）
    const nowT = Date.now();
    const tl = [];
    if (a.win) {
      tl.push([fmtTime(a.win.startTs), a.win.startT < nowT ? "风雨已开始" : "预计风雨开始"]);
      tl.push([fmtTime(a.closest.time), ptime(a.closest) < nowT
        ? `台风最近时刻已过（约 ${Math.round(a.closest.dist)} km）`
        : `台风最近约 ${Math.round(a.closest.dist)} km`]);
      if (a.win.open) tl.push(["", "<b>预报期内未见明显结束信号</b>——警惕累计雨量"]);
      else tl.push([fmtTime(a.win.endTs), a.win.endT < nowT ? "风雨已基本结束" : "预计风雨基本结束"]);
      if (a.phase === "after" && a.postRain24 !== null && a.postRain24 >= 1) {
        tl.push(["", a.postRain24 >= 30
          ? `<b>未来24小时预计仍有约 ${a.postRain24} mm 降雨</b>——过境不等于结束（模式预报）`
          : `<span class="muted">未来24小时残余降雨约 ${a.postRain24} mm（模式预报）</span>`]);
      }
      if (a.durationH && a.phase === "approach") tl.push(["", `影响持续约 <b>${Math.round(a.durationH)} 小时</b>${a.slowThreat ? "（停留型，明显偏长）" : a.longRain ? "（持续偏长，雨量会累积）" : ""}`]);
      tl.push(["", `<span class="muted">时间窗来源：${a.win.src === "模式" ? "本地逐时数值预报" : "官方路径几何推算"}</span>`]);
    }
    if (a.win) {
      tl.push(["", `预计过程雨量约 <b>${a.rain} mm</b><span class="muted">（${a.rainSrc === "模式预报" ? "数值模式预报" : "演示估算，模式数据加载中"}）</span>`]);
    } else if (a.closing) {
      tl.push(["", `<b>台风正向你的方向移动</b>，现有预报${a.fcEndTs ? `（至 ${fmtTime(a.fcEndTs)}）` : ""}范围内尚不会影响本地。`]);
      tl.push(["", `<span class="muted">5 天外的路径不确定性很大——预报每 6 小时更新，请每天回来查看，等它进入预报可判断范围。</span>`]);
    } else {
      tl.push(["", `<span class="muted">本台风预计不会给本地带来明显风雨（最近约 ${Math.round(a.closest.dist)} km，远超其风圈）。本地若有降雨，属于正常天气过程，与该台风无关。</span>`]);
    }
    if (a.peakRain) tl.push([fmtTime(a.peakRain.ts.replace("T", " ")), `本地雨强峰值（约 ${Math.round(a.peakRain.v)} mm/h，模式预报）`]);
    if (a.peakGust) tl.push([fmtTime(a.peakGust.ts.replace("T", " ")), `本地阵风最强（约 ${gustLevel(a.peakGust.v)} 级，模式预报）`]);
    const ante = P.antecedent[`${P.loc.lat},${P.loc.lng}`];
    if (ante && typeof ante === "object") {
      const wetTxt = ante.w >= 0.6 ? "土壤接近饱和" : ante.w >= 0.35 ? "土壤偏湿" : "土壤偏干";
      tl.push(["", ante.w >= 0.6
        ? `过去两周已降 <b>${ante.sum14} mm</b>，${wetTxt}——同样的雨更易致涝，致灾门槛已按湿土下调`
        : `<span class="muted">过去两周已降 ${ante.sum14} mm，${wetTxt}（前期影响雨量 ${ante.pa} mm）</span>`]);
    }
    document.querySelector("#d-timeline > div").innerHTML =
      tl.map(([t, x]) => `<div class="tl-row">${t ? `<span class="t">${t}</span>` : ""}<span>${x}</span></div>`).join("");

    // 本地历史档案（IBTrACS 客观统计——你正在经历的是常态还是异常）
    let histHTML = "";
    const hist = P.history &&
      (P.history.d[`${P.loc.province}|${P.loc.city}|${P.loc.district || ""}`] ||
       P.history.d[`${P.loc.province}|${P.loc.city}|`]);
    if (hist) {
      const m = P.history.meta;
      const [c100, c300, month, top] = hist;
      const freq = c100 > 0 ? `，约每 ${Math.max(1, Math.round(m.years / c100))} 年一次` : "";
      histHTML = `
        <div style="margin-bottom:8px">
          本地档案 <span class="muted">（${m.source}，${m.since} 年以来）</span><br>
          台风中心 ${m.near_km}km 内经过 <b>${c100}</b> 次${freq}；${m.wide_km}km 内 ${c300} 次，${month} 月最高发<br>
          <span class="muted">最强过境：${top.map((t) => `${t[1]} ${t[0]}·距${t[2]}km`).join(" ／ ")}</span>
        </div>
        <div style="border-top:1px solid var(--hairline);padding-top:8px"></div>`;
    }

    // 本地气候标定：同样的雨在不同城市完全不是一回事——100mm 在屏东排第 16 百分位
    // （中位 216mm），在北京却是有记录以来最大。用这座城市自己的台风降雨史来说话，
    // 才把「脆弱性/气候背景」这一维补上。仅作表达与标定，不直接改判档。
    let pctHTML = "";
    const pctRec = P.rainPct && P.rainPct.d && P.rainPct.d[P.loc.city];
    if (pctRec && pctRec.v.length >= 10 && a.relevant && a.rain > 0) {
      const n = pctRec.v.length;
      const p = Math.round(100 * pctRec.v.filter((v) => v <= a.rain).length / n);
      const tone = p >= 90 ? "在本地属**罕见量级**" : p >= 70 ? "高于本地多数台风" :
                   p >= 40 ? "属本地中等水平" : "低于本地多数台风";
      // 不再重复列「本地最强」——下方的同城案例对照已给出具体台风与当时的影响
      pctHTML = `
        <div style="margin-bottom:8px">
          本次 <b>${a.rain}mm</b> 在本地台风降雨史中排 <b>第 ${p} 百分位</b>
          <span class="muted">（近 ${n} 场台风样本 · ${tone.replace(/\*\*/g, "")}）</span>
        </div>
        <div style="border-top:1px solid var(--hairline);padding-top:8px"></div>`;
    }

    // 历史对照：同城才做量化对比；异地只做量级参考并明说局限
    const inPower = parseInt(a.closest.power) || 0;
    const { analog, local, quant, mode, strongest } = findAnalog(a.rain, inPower);
    let analogHTML = "";
    if (analog && local && quant && mode === "wind") {
      analogHTML = `
        本次为强风型台风（约 ${inPower} 级），本地最接近的记忆：
        <b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>（${analog.hazard.peakPower} 级）
        <div class="quote">${analog.narrative}</div>`;
    } else if (analog && local && quant && a.rain > 0) {
      const ratio = a.rain / analog.hazard.rainTotalMm;
      const compare = ratio > 1.3 ? "已超过" : ratio >= 0.7 ? "接近" : `约为其 ${Math.round(ratio * 100)}%，远小于`;
      analogHTML = `
        预计雨量 ${a.rain}mm ${compare}
        <b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>时本地的 ${analog.hazard.rainTotalMm}mm
        <div class="quote">${analog.narrative}</div>`;
    } else if (analog && local) {
      // 本次没有有效雨量时绝不做百分比对比——「0mm 约为其 0%」比不说更误导
      const why = quant ? "（本台风预计不给本地带来明显降雨，不作量化对比）"
                        : "（该案例无雨量记录，不作量化对比）";
      analogHTML = `
        本地案例：<b>${analog.typhoon.tfid.slice(0, 4)}年${analog.typhoon.name}</b>
        <span class="muted">${why}</span>
        <div class="quote">${analog.narrative}</div>`;
    } else if (analog && a.rain >= 50 && analog.hazard.rainTotalMm <= a.rain * 2.5 && analog.hazard.rainTotalMm >= a.rain * 0.4) {
      // 异地量级参考：仅当预计雨量可观且与案例确实同量级时才展示
      analogHTML = `
        <span class="muted">本地（${P.loc.city}）暂无历史对照案例——异地案例无法体现本地排水与地形，
        不作量化对比。以下仅供感受同量级降雨的可能后果：</span>
        <div class="quote">${analog.narrative}</div>
        <span class="muted">欢迎依据《气象灾害年鉴》为本地补充案例（见仓库 CONTRIBUTING）。</span>`;
    } else {
      analogHTML = `
        <span class="muted">本地（${P.loc.city}）暂无历史对照案例${a.rain < 50 ? "，且本次预计雨量有限，无需对照" : "，且现有案例与本次量级差距过大，不作参考"}。
        欢迎依据《气象灾害年鉴》为本地补充案例（见仓库 CONTRIBUTING）。</span>`;
    }
    if (strongest && analog && strongest.eventId !== analog.eventId) {
      const sp2 = strongest.hazard.peakPower ? `（${strongest.hazard.peakPower}级${strongest.hazard.landfall ? "登陆" : ""}）` : "";
      analogHTML += `
        <div style="border-top:1px solid var(--hairline);margin-top:8px;padding-top:8px">
          本地最强纪录：<b>${strongest.typhoon.tfid.slice(0, 4)}年${strongest.typhoon.name}</b>${sp2}
          <div class="quote">${strongest.narrative}</div>
        </div>`;
    }
    document.querySelector("#d-analog > div").innerHTML = histHTML + pctHTML + analogHTML;

    // 清单（按阶段：备灾 / 避险 / 恢复期）
    const items = phaseChecklist(a);
    // 内涝清单：雨量到了内涝量级就给，**不等用户自认「住低洼」**。上海白海豚教训——
    // 过程 210mm、连续两天各 91mm，别墅负一楼与临街商铺进水，而这些人未必勾了
    // 「低洼/商铺」情境，于是精准的防内涝条目根本没送到他们眼前。内涝风险由雨量
    // 决定，不由用户怎么给自己归类决定。已勾相应情境的不再重复。
    const fe = P.checklists.flood_extra;
    const floodRisk = a.relevant && a.rain >= 50 * (1 - SOIL_DROP * (a.soilW || 0));
    if (fe && floodRisk && a.phase !== "after" &&
        !(P.situations.has("lowland") || P.situations.has("shop"))) {
      items.unshift(...fe.items);
    }
    // 海浪清单：沿海/海岛 + 外海浪高达提示级时，置于最前（对海边人，海才是即时危险）
    if (wave && !wave.none && P.checklists.wave_extra) {
      const we = P.checklists.wave_extra;
      items.unshift(...(we.generic || []).concat(we[P.persona] || []));
    }
    // 财产处置提示：仅在登陆前、清单真出现「折价抢收/起捕/出栏」这类不可逆
    // 花钱决策时，附一小句通用提示在「非官方预警」后——数据仅供参考，请自行判断
    const rn = P.checklists.risk_note;
    const preImpact = a.phase !== "during" && a.phase !== "after";
    const hasDisposal = /抢收|起捕|出栏|折价|抛售/.test(items.join(""));
    const riskHTML = (rn && preImpact && hasDisposal)
      ? `<span class="risk-hint">${rn}</span>` : "";
    document.querySelector("#d-checklist > div").innerHTML =
      items.map((item) => `
        <label class="check-row"><input type="checkbox"><span>${item}</span></label>`).join("") +
      `<div class="muted" style="margin-top:6px">依据气象部门防御指引与历史灾害经验整理 · 非官方预警${riskHTML}</div>`;
    document.querySelectorAll("#d-checklist .check-row input").forEach((el2) => {
      el2.onchange = () => el2.closest(".check-row").classList.toggle("done", el2.checked);
    });

    renderBar();
  }

  /* ---------- 分享卡（现代版：示意图 + 数据宫格 + 行动建议） ---------- */

  let lastCardName = "台风与蝉";
  function bindShare() {
    document.getElementById("share-btn").onclick = drawShareCard;
    const mb = document.getElementById("manual-btn");
    if (mb) mb.onclick = drawSurvivalManual;
    document.getElementById("share-close").onclick = () =>
      (document.getElementById("share-modal").style.display = "none");
    document.getElementById("share-save").onclick = () => {
      const link = document.createElement("a");
      link.download = `${lastCardName}.png`;
      link.href = document.getElementById("share-canvas").toDataURL("image/png");
      link.click();
    };
  }

  /* ---------- 应急手册长图：存手机、断网断电时打开照着做 ----------
     阅读层级：三原则（总纲）→ 判断严重程度（对号入座）→ ①②③ 分级行动
     （颜色由缓到急、按顺序排）→ 求救号/撑几天/风雨后（参考）→ 人群专属 */
  function drawSurvivalManual() {
    const m = P.survival;
    if (!m) return;
    lastCardName = `台风应急手册-${locLabel()}`;
    const { focus } = assessAll();
    const storm = focus ? focus.s.name : "";
    const W = 780, PAD = 44, CW = W - PAD * 2, SCALE = 2;
    const LC = { green: "#7cbf6b", amber: "#ea8640", red: "#e46b60" };
    const LH = 38;                                 // 正文行高（放松）
    const IND = 28;                                // 项目缩进
    const BODY = 24;                               // 正文字号
    const canvas = document.getElementById("share-canvas");
    const ctx = canvas.getContext("2d");
    // 正文用黑体（小字号更清楚），标题/序号用衷线（有性格）
    const FB = (w, px) => `${w} ${px}px -apple-system, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif`;
    const FD = (w, px) => `${w} ${px}px Georgia, "Songti SC", "STSong", "SimSun", serif`;

    const lines = (text, font, maxW) => {
      ctx.font = font;
      let line = "", n = 0;
      for (const ch of text) {
        if (ctx.measureText(line + ch).width > maxW) { n++; line = ch; } else line += ch;
      }
      return n + (line ? 1 : 0);
    };
    const wrap = (text, x, y, font, maxW, lh, color) => {
      ctx.font = font; ctx.fillStyle = color;
      let line = "", cy = y;
      for (const ch of text) {
        if (ctx.measureText(line + ch).width > maxW) { ctx.fillText(line, x, cy); line = ch; cy += lh; }
        else line += ch;
      }
      if (line) ctx.fillText(line, x, cy);
      return cy + lh;
    };
    const bulletH = (it) => lines(it, FB(400, BODY), CW - IND - 12) * LH + 11;

    const pex = m.persona_extra[P.persona];

    // ── 测高 pass ──
    let H = 46;
    H += 56 + 34;
    H += lines(m.intro, FB(400, 19), CW) * 29 + 22;
    H += 16 + m.principles.length * 42 + 12 + 30;
    H += 44;
    for (const r of m.locate.rows) H += lines(r.state, FB(500, 20), CW - 56) * 29 + 28 + 14;
    H += 18;
    for (const t of m.tiers) {
      H += 48 + lines(t.sub, FB(400, 18), CW - 56) * 26 + 10;
      for (const it of t.items) H += bulletH(it);
      H += 26;
    }
    for (const ref of m.refs) {
      H += 42;
      for (const it of ref.items) H += bulletH(it);
      H += 18;
    }
    if (pex) H += 28 + lines(pex, FB(500, 22), CW - 36) * LH + 30;
    H += 20 + lines(m.footer, FB(400, 15), CW) * 23 + 40;

    canvas.width = W * SCALE; canvas.height = H * SCALE;
    ctx.scale(SCALE, SCALE);

    // ── 绘制 pass ──
    roundRect(ctx, 0, 0, W, H, 30); ctx.clip();
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#25231f"); bg.addColorStop(1, "#1a1916");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    const badge = (x, cyTop, n, color, s) => {
      ctx.fillStyle = color; roundRect(ctx, x, cyTop, s, s, 7); ctx.fill();
      ctx.fillStyle = "#1a1916"; ctx.font = FD(800, s - 8); ctx.textAlign = "center";
      ctx.fillText(n, x + s / 2, cyTop + s - Math.round(s * 0.28));
      ctx.textAlign = "left";
    };
    const bullet = (it, y, color) => {
      ctx.fillStyle = color; ctx.beginPath();
      ctx.arc(PAD + 7, y - 8, 3.2, 0, 7); ctx.fill();
      return wrap(it, PAD + IND, y, FB(400, BODY), CW - IND - 12, LH, "#e3dfd5") + 11;
    };

    let y = 66;
    ctx.textAlign = "left";
    ctx.fillStyle = "#efece6"; ctx.font = FD(800, 40);
    ctx.fillText(m.title, PAD, y); y += 32;
    ctx.fillStyle = "#ea8640"; ctx.font = FB(600, 18);
    ctx.fillText(`${locLabel()}${storm ? " · " + storm : ""} · ${m.kicker}`, PAD, y); y += 30;
    y = wrap(m.intro, PAD, y, FB(400, 19), CW, 29, "#b3ad9f") + 6;

    const boxTop = y, boxH = 16 + m.principles.length * 42 + 8;
    ctx.fillStyle = "rgba(234,134,64,0.10)";
    roundRect(ctx, PAD, boxTop, CW, boxH, 12); ctx.fill();
    ctx.strokeStyle = "#ea8640"; ctx.lineWidth = 1.5;
    roundRect(ctx, PAD, boxTop, CW, boxH, 12); ctx.stroke();
    let py = boxTop + 42;
    m.principles.forEach((pr, i) => {
      ctx.fillStyle = "#ea8640"; ctx.font = FD(800, 26);
      ctx.fillText(`${i + 1}`, PAD + 20, py);
      ctx.fillStyle = "#efece6"; ctx.font = FB(700, 22);
      ctx.fillText(pr, PAD + 50, py);
      py += 42;
    });
    y = boxTop + boxH + 30;

    ctx.fillStyle = "#efece6"; ctx.font = FD(800, 24);
    ctx.fillText(m.locate.h, PAD, y); y += 38;
    for (const r of m.locate.rows) {
      const c = LC[r.level];
      badge(PAD, y - 17, r.n, c, 24);
      const yA = wrap(r.state, PAD + 38, y, FB(500, 20), CW - 56, 29, "#efece6");
      ctx.fillStyle = c; ctx.font = FB(700, 19);
      ctx.fillText(`→ ${r.act}`, PAD + 38, yA + 3);
      y = yA + 28 + 14;
    }
    y += 18;

    for (const t of m.tiers) {
      const c = LC[t.level];
      badge(PAD, y - 24, t.n, c, 32);
      ctx.fillStyle = c; ctx.font = FD(800, 26);
      ctx.fillText(t.h, PAD + 46, y); y += 26;
      y = wrap(t.sub, PAD + 46, y, FB(400, 18), CW - 56, 26, "#9a958c") + 10;
      const listTop = y;
      for (const it of t.items) y = bullet(it, y, c);
      ctx.fillStyle = c; ctx.globalAlpha = 0.5;
      ctx.fillRect(PAD + 15, listTop - 5, 2, y - listTop - 4);
      ctx.globalAlpha = 1;
      y += 26;
    }

    for (const ref of m.refs) {
      ctx.fillStyle = "#eeb28f"; ctx.font = FD(800, 22);
      ctx.fillText(ref.h, PAD, y); y += 34;
      for (const it of ref.items) y = bullet(it, y, "#c9a961");
      y += 18;
    }

    if (pex) {
      const bT = y, bH = 16 + lines(pex, FB(500, 22), CW - 36) * LH + 8;
      ctx.fillStyle = "rgba(201,169,97,0.12)";
      roundRect(ctx, PAD, bT, CW, bH, 12); ctx.fill();
      ctx.fillStyle = "#c9a961"; ctx.font = FB(600, 16);
      ctx.fillText(`给「${(P.checklists.personas.find((p) => p.id === P.persona) || {}).name || "你"}」的一句`, PAD + 18, bT + 30);
      wrap(pex, PAD + 18, bT + 56, FB(500, 22), CW - 36, LH, "#efece6");
      y = bT + bH + 30;
    }

    ctx.fillStyle = "#76726a"; ctx.textAlign = "center";
    wrap(m.footer, W / 2, y + 14, FB(400, 15), CW, 23, "#76726a");
    ctx.textAlign = "left";

    document.getElementById("share-modal").style.display = "flex";
  }

  /* 分享卡底图：与主地图同源的 Carto dark 瓦片，位置/风圈/路径按真实地理投影 */
  const TILE = (z, x, y) => `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png`;

  function mercPx(lat, lng, z) {
    const n = 256 * Math.pow(2, z);
    const s2 = Math.sin(lat * Math.PI / 180);
    return [(lng + 180) / 360 * n,
      (0.5 - Math.log((1 + s2) / (1 - s2)) / (4 * Math.PI)) * n];
  }

  // 选一个能同时装下「风圈整圆 + 你的位置」的最大缩放级
  function fitMap(storm, user, galeR, w, h) {
    const dLat = galeR / 111.32;
    const dLng = galeR / (111.32 * Math.cos(storm.lat * Math.PI / 180));
    const feats = [
      [storm.lat, storm.lng], [user.lat, user.lng],
      [storm.lat + dLat, storm.lng], [storm.lat - dLat, storm.lng],
      [storm.lat, storm.lng + dLng], [storm.lat, storm.lng - dLng],
    ];
    const pts = feats.map((f) => mercPx(f[0], f[1], 0));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const bw = Math.max(Math.max(...xs) - Math.min(...xs), 1e-9);
    const bh = Math.max(Math.max(...ys) - Math.min(...ys), 1e-9);
    // 连续缩放级：恰好装下（瓦片取整数级后放大补差），避免整级取整浪费一半画幅
    const z = Math.max(3, Math.min(
      Math.log2(Math.min((w - 120) / bw, (h - 150) / bh)), 10));
    const k = Math.pow(2, z);
    return { z, cx: (Math.max(...xs) + Math.min(...xs)) / 2 * k,
             cy: (Math.max(...ys) + Math.min(...ys)) / 2 * k };
  }

  function loadTiles(view, hx, hy, hw, hh) {
    const zi = Math.floor(view.z);
    const size = 256 * Math.pow(2, view.z - zi); // 瓦片在目标缩放下的实际边长
    const ox = view.cx - hw / 2, oy = view.cy - hh / 2;
    const n = Math.pow(2, zi);
    const jobs = [];
    for (let tx = Math.floor(ox / size); tx <= Math.floor((ox + hw) / size); tx++)
      for (let ty = Math.floor(oy / size); ty <= Math.floor((oy + hh) / size); ty++) {
        if (ty < 0 || ty >= n) continue;
        jobs.push(new Promise((res) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => res({ img, dx: hx + tx * size - ox, dy: hy + ty * size - oy, s: size });
          img.onerror = () => res(null);
          img.src = TILE(zi, ((tx % n) + n) % n, ty);
        }));
      }
    return Promise.race([Promise.all(jobs),
      new Promise((r) => setTimeout(() => r(null), 4000))]);
  }

  // 气象台风符号：核心圆 + 两条渐细旋臂
  function drawCyclone(ctx, x, y, r) {
    const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.6);
    glow.addColorStop(0, "rgba(234,134,64,0.38)");
    glow.addColorStop(1, "rgba(234,134,64,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 3.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ea8640";
    for (const flip of [0, Math.PI]) {
      const outer = [], inner = [];
      for (let t = 0; t <= 1.001; t += 0.07) {
        const ang = flip - 0.55 - t * 1.8;
        const rr = r * (1.05 + t * 1.5);
        const w = r * (0.8 * (1 - t) + 0.1);
        const cx2 = x + rr * Math.cos(ang), cy2 = y + rr * Math.sin(ang);
        outer.push([cx2 + Math.cos(ang) * w / 2, cy2 + Math.sin(ang) * w / 2]);
        inner.push([cx2 - Math.cos(ang) * w / 2, cy2 - Math.sin(ang) * w / 2]);
      }
      ctx.beginPath();
      outer.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      inner.reverse().forEach((q) => ctx.lineTo(q[0], q[1]));
      ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#14130f";
    ctx.beginPath(); ctx.arc(x, y, r * 0.42, 0, Math.PI * 2); ctx.fill();
  }

  // 带底衬的标签（地图上文字必须有底衬才可读）；返回占位框
  function pill(ctx, F, cx, cyy, text, weight, size, fg, bg) {
    ctx.font = F(weight, size);
    const w = ctx.measureText(text).width + 26, h = size + 15;
    ctx.fillStyle = bg || "rgba(20,19,15,0.78)";
    roundRect(ctx, cx - w / 2, cyy - h / 2, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cyy + 1);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    return { x: cx - w / 2, y: cyy - h / 2, w, h };
  }

  async function drawShareCard() {
    if (!P.storms.length) return;
    const { focus } = assessAll();
    const a = focus.a, s = focus.s;
    lastCardName = `台风${s.name}-${locLabel()}影响卡`;
    const last = s.track[s.track.length - 1];
    const dist = haversine(P.loc.lat, P.loc.lng, last.lat, last.lng);
    const hx = 36, hy = 76, hw = 750 - 72, hh = 380;
    const view = fitMap(last, { lat: P.loc.lat, lng: P.loc.lng }, a.galeR, hw, hh);
    renderCard(a, s, last, dist, view, null);
    document.getElementById("share-modal").style.display = "flex";
    const tiles = await loadTiles(view, hx, hy, hw, hh);
    if (tiles && tiles.some(Boolean)) renderCard(a, s, last, dist, view, tiles);
  }

  function renderCard(a, s, last, dist, view, tiles) {
    const accent = LV_STYLE[a.level].color;
    const W = 750, H = 1120, SCALE = 2;
    const canvas = document.getElementById("share-canvas");
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    const ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);
    const F = (w, px) => `${w} ${px}px Georgia, "Songti SC", "STSong", "SimSun", serif`;

    // 整卡圆角（导出 PNG 四角透明）
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.clip();

    // 背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#25231f");
    bg.addColorStop(1, "#1a1916");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 顶栏
    ctx.fillStyle = "#76726a";
    ctx.font = F(600, 21);
    ctx.fillText("台风与蝉 · TYPHOON & CICADA", 36, 52);
    ctx.textAlign = "right";
    ctx.fillText(last.time.slice(5, 16), W - 36, 52);
    ctx.textAlign = "left";

    /* ---- hero：真实地图上的你与台风 ---- */
    const hx = 36, hy = 76, hw = W - 72, hh = 380;
    ctx.save();
    roundRect(ctx, hx, hy, hw, hh, 16);
    ctx.clip();
    ctx.fillStyle = "#15140f";
    ctx.fillRect(hx, hy, hw, hh);
    if (tiles) {
      for (const t of tiles) if (t) ctx.drawImage(t.img, t.dx, t.dy, t.s, t.s);
      ctx.fillStyle = "rgba(21,20,15,0.22)"; // 品牌暗色压一层，保证文字对比
      ctx.fillRect(hx, hy, hw, hh);
    }

    const px = (lat, lng) => {
      const q = mercPx(lat, lng, view.z);
      return [hx + hw / 2 + q[0] - view.cx, hy + hh / 2 + q[1] - view.cy];
    };
    const [sx, sy] = px(last.lat, last.lng);
    const [ux, uy] = px(P.loc.lat, P.loc.lng);
    const rPx = Math.abs(mercPx(last.lat + a.galeR / 111.32, last.lng, view.z)[1] -
      mercPx(last.lat, last.lng, view.z)[1]);

    // 已走过的路径（细线，终点即台风符号，自然读出移动方向）
    ctx.strokeStyle = "rgba(238,236,230,0.42)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    s.track.forEach((q, i) => {
      const [tx2, ty2] = px(q.lat, q.lng);
      i ? ctx.lineTo(tx2, ty2) : ctx.moveTo(tx2, ty2);
    });
    ctx.stroke();

    // 7级风圈（真实半径投影）
    ctx.fillStyle = "rgba(234,134,64,0.09)";
    ctx.beginPath(); ctx.arc(sx, sy, rPx, 0, Math.PI * 2); ctx.fill();
    ctx.setLineDash([7, 6]);
    ctx.strokeStyle = "rgba(234,134,64,0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, rPx, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    pill(ctx, F, sx, sy - rPx - 16,
      `7级风圈${a.galeREst ? "估算" : ""} ${Math.round(a.galeR)} km${dist <= a.galeR ? " · 你在圈内" : ""}`,
      400, 17, "rgba(240,190,140,0.95)");

    // 连线 + 距离（沿线中点，垂向偏移避让）
    const dx2 = ux - sx, dy2 = uy - sy, L = Math.hypot(dx2, dy2) || 1;
    const ex = dx2 / L, ey = dy2 / L;
    if (L > 52) {
      ctx.strokeStyle = "rgba(238,236,230,0.6)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 7]);
      ctx.beginPath();
      ctx.moveTo(sx + ex * 30, sy + ey * 30);
      ctx.lineTo(ux - ex * 14, uy - ey * 14);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 距离标注：连线够长才独立展示，否则并入「你」的标签（近距离时中心区放不下）
    const showDistPill = L > 150;
    if (showDistPill) {
      const mx = (sx + ux) / 2, my = (sy + uy) / 2;
      const cand = [[mx - ey * 34, my + ex * 34], [mx + ey * 34, my - ex * 34]];
      const dxy = cand[0][1] < cand[1][1] ? cand[0] : cand[1]; // 取偏上的一侧
      pill(ctx, F, dxy[0], dxy[1], `${Math.round(dist)} km`, 800, 26, "#eeece6");
    }

    // 台风符号 + 你的位置
    drawCyclone(ctx, sx, sy, 11);
    ctx.fillStyle = "rgba(238,236,230,0.18)";
    ctx.beginPath(); ctx.arc(ux, uy, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#eeece6";
    ctx.beginPath(); ctx.arc(ux, uy, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#14130f"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ux, uy, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;

    // 两端身份标签沿连线向各自外侧展开——近距离时也不会互相压盖
    const clampXY = (cx2, cy2, w2, h2) => [
      Math.max(hx + w2 / 2 + 8, Math.min(cx2, hx + hw - w2 / 2 - 8)),
      Math.max(hy + h2 / 2 + 8, Math.min(cy2, hy + hh - h2 / 2 - 30))];
    ctx.font = F(700, 20);
    const sTxt = `${s.name} · ${last.power}级`;
    const uTxt = showDistPill ? `你 · ${locLabel()}` : `你 · ${locLabel()} · ${Math.round(dist)} km`;
    const swm = ctx.measureText(sTxt).width + 26;
    const uwm = ctx.measureText(uTxt).width + 26;
    if (L > 40) {
      const [scx, scy] = clampXY(sx - ex * (40 + swm / 2), sy - ey * (40 + swm / 2), swm, 35);
      pill(ctx, F, scx, scy, sTxt, 700, 20, "#eeb28f");
      const [ucx, ucy] = clampXY(ux + ex * (26 + uwm / 2), uy + ey * (26 + uwm / 2), uwm, 35);
      pill(ctx, F, ucx, ucy, uTxt, 700, 20, "#eeece6");
    } else { // 几乎重合：上下排布
      pill(ctx, F, clampXY(sx, sy - 44, swm, 35)[0], sy - 44, sTxt, 700, 20, "#eeb28f");
      pill(ctx, F, clampXY(ux, uy + 44, uwm, 35)[0], uy + 44, uTxt, 700, 20, "#eeece6");
    }

    ctx.fillStyle = "rgba(238,236,230,0.4)";
    ctx.font = F(400, 15);
    ctx.fillText("位置 · 风圈 · 路径按真实地理绘制", hx + 14, hy + hh - 12);
    if (tiles) {
      ctx.textAlign = "right";
      ctx.fillText("© CARTO © OpenStreetMap", hx + hw - 12, hy + hh - 12);
      ctx.textAlign = "left";
    }
    ctx.restore();

    /* ---- 结论（流式布局：标题可能折两行，后续内容跟着下移，绝不重叠） ---- */
    ctx.fillStyle = "#eeece6";
    ctx.font = F(800, 40);
    const hLines = wrapText(ctx, headlineFor(a), 36, 540, W - 72, 52);
    let yy = 540 + (hLines - 1) * 52; // 标题最后一行基线
    ctx.fillStyle = "#aaa69f";
    ctx.font = F(400, 22);
    yy += 56;
    ctx.fillText((a.slowThreat || a.longRain) ? "风雨持续时间长：雨量不断累积，重点防内涝而不是防风"
      : "台风强度 ≠ 你受影响的程度，距离和路径才是关键", 36, yy);

    /* ---- 数据宫格 ---- */
    const stats = [
      { v: `${Math.round(dist)}`, u: "km", k: "当前距离" },
      { v: `${last.power}`, u: "级", k: "台风强度" },
      { v: `${a.rain}`, u: "mm", k: a.phase === "approach" ? "预计雨量" : "过程雨量" },
      { v: a.endPoint ? fmtTime(a.endPoint.time) : "—", u: "", k: "预计结束" },
    ];
    const gw = (W - 72 - 3 * 12) / 4;
    const gy = yy + 32;
    stats.forEach((st2, i) => {
      const gx = 36 + i * (gw + 12);
      ctx.fillStyle = "#26241e";
      roundRect(ctx, gx, gy, gw, 108, 14);
      ctx.fill();
      ctx.fillStyle = "#eeece6";
      ctx.font = F(800, st2.v.length > 5 ? 26 : 36);
      ctx.fillText(st2.v, gx + 16, gy + 52);
      if (st2.u) {
        ctx.fillStyle = "#aaa69f";
        ctx.font = F(600, 20);
        ctx.fillText(st2.u, gx + 18 + ctx.measureText(st2.v).width * (st2.v.length > 5 ? 1.35 : 1.85), gy + 52);
      }
      ctx.fillStyle = "#76726a";
      ctx.font = F(400, 20);
      ctx.fillText(st2.k, gx + 16, gy + 86);
    });

    /* ---- 行动建议：分享卡是海报不是文档——标题占两行时只放 2 条，保住留白 ---- */
    const ty = gy + 108 + 60;
    ctx.fillStyle = "#eeece6";
    ctx.font = F(800, 26);
    ctx.fillText("现在该做的", 36, ty);
    const items = phaseChecklist(a).slice(0, hLines > 1 ? 2 : 3);
    items.forEach((item, i) => {
      const iy = ty + 34 + i * 74;
      ctx.fillStyle = "#26241e";
      roundRect(ctx, 36, iy, W - 72, 60, 12);
      ctx.fill();
      ctx.fillStyle = accent;
      roundRect(ctx, 52, iy + 19, 22, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#c9c5bc";
      ctx.font = F(400, 23);
      // 按像素宽截断，避免定长截字导致过早或过晚出现省略号
      const maxTw = W - 72 - 54 - 34;
      let text = item;
      while (text.length > 1 && ctx.measureText(text).width > maxTw) text = text.slice(0, -1);
      if (text !== item) text = text.slice(0, -1) + "…";
      ctx.fillText(text, 90, iy + 39);
    });

    // 底部
    ctx.fillStyle = "#76726a";
    ctx.font = F(400, 18);
    ctx.textAlign = "center";
    ctx.fillText("非官方预警 · 以气象部门发布为准 · 公益项目 by 日成Risen · typhoonandcicada", W / 2, H - 22);
    ctx.textAlign = "left";
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    let line = "", cy = y, lines = 0;
    for (const ch of text) {
      if (ctx.measureText(line + ch).width > maxWidth) {
        ctx.fillText(line, x, cy);
        line = ch;
        cy += lineHeight;
        lines++;
      } else {
        line += ch;
      }
    }
    if (line) { ctx.fillText(line, x, cy); lines++; }
    return lines;
  }

  /* ---------- utils ---------- */

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
    return maxRadius(p) || TyphoonData.estGaleRadius(p && p.power);
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
  function rainDirFactor(seq, closest) {
    const mv = moveBearingAt(seq, ptime(closest));
    if (mv == null) return null;
    const toMe = bearing(closest.lat, closest.lng, P.loc.lat, P.loc.lng);
    const rel = (((toMe - mv) % 360) + 360) % 360;
    return 0.65 + 0.35 * Math.cos((rel - 45) * Math.PI / 180);
  }
  /* 数据时间均为北京时间：显式按 +08:00 解析，海外浏览器也能与 Date.now() 正确比较 */
  function ptime(p) { return new Date(p.time.replace(" ", "T") + "+08:00").getTime(); }

  function fmtTime(str) {
    if (!str) return "—";
    const m = str.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2})/);
    return m ? `${+m[3]}日${m[4]}时` : str;
  }

  async function fetchJSON2(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  return { init, updateAll };
})();
