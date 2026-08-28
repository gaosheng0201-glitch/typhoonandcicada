#!/usr/bin/env node
/* 判定口径抽样自检（node 版）——与前端共用 docs/assess-core.js 这**同一个**评估核心。

   为什么换掉 Python 版：sanity_check.py 是 assess() 的平行复刻，同步过五次仍有漂移
   （Pa 公式最近一天权重 panel 用 K¹、Python 用 K⁰）——验收工具与被验收对象是两套
   实现，验收本身不可信。本脚本只负责**取数**（与前端同源：温州台风网 + Open-Meteo），
   判定全部交给 core：core 一改，这里自动跟随，永远不会漂。

   用法（与 Python 版一致）：
     node scripts/sanity_check.mjs 202618
     node scripts/sanity_check.mjs 202618 --sweep
     node scripts/sanity_check.mjs 202610 --at 2026-07-04T12 --cities 南宁市,北海市
     node scripts/sanity_check.mjs 202618 --event --cities 台州市,温州市
                                          # 事件时间线层(Phase B)：整场事件的档位曲线、
                                          # 峰值档与此刻档的关系（「曾4现2」类事实）
*/
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ① 同一把尺子：直接 require 前端的 assess-core.js
const AssessCore = require(path.join(ROOT, "docs", "assess-core.js"));
// ② estGaleRadius 权威表在 data.js：vm 执行拿 TyphoonData（不复制表）
const dataCtx = {};
vm.createContext(dataCtx);
vm.runInContext(readFileSync(path.join(ROOT, "docs", "data.js"), "utf-8") +
  ";globalThis.__T = TyphoonData;", dataCtx);
AssessCore.configure({ estGaleRadius: dataCtx.__T.estGaleRadius });

const BJT_OFF = 8 * 3600e3;
const fmtBJT = (ms) => new Date(ms + BJT_OFF).toISOString().slice(0, 16).replace("T", " ");

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "typhoonandcicada-selftest" } });
      const s = await r.text();
      if (s.trim()) return JSON.parse(s);
    } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("接口多次为空: " + url);
}

function loadCityCoords() {
  const reg = JSON.parse(readFileSync(path.join(ROOT, "docs", "data", "regions.json"), "utf-8"));
  const out = {};
  for (const pv of Object.values(reg))
    for (const [city, cv] of Object.entries(pv.cities || {})) out[city] = { lat: cv.lat, lng: cv.lng };
  return out;
}

/* 台风 → data.js normalize 后的形状（track/forecasts），取数逻辑与前端 loadStorm 对齐 */
async function loadStorm(tfid) {
  const d = await get(`https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo/${tfid}`);
  const pts = d.points || [];
  const norm = (p) => ({ time: p.time.replace("T", " ").split("+")[0].split(".")[0],
    lat: +p.lat, lng: +p.lng, strong: p.strong || "", power: p.power || "",
    r7: p.radius7 ? String(p.radius7).split("|").filter(Boolean).map(Number) : null });
  const fcs = {};
  for (let i = pts.length - 1; i >= 0; i--) {
    for (const fc of pts[i].forecast || []) {
      if (fc.tm && !fcs[fc.tm] && (fc.forecastpoints || []).length)
        fcs[fc.tm] = { points: fc.forecastpoints.map(norm) };
    }
    if (Object.keys(fcs).length) break;
  }
  return { name: d.name, storm: { tfid, track: pts.map(norm), forecasts: fcs } };
}

/* 逐时风雨 → 前端 fdata 形状 {t(毫秒),ts,p,g,cur}；daily → soilFromDaily（core 口径） */
function toFdata(hourly) {
  const ts = hourly.time;                                 // "YYYY-MM-DDTHH:MM" 北京钟面
  const t = ts.map((s) => new Date(s + ":00+08:00").getTime());
  return { t, ts, p: hourly.precipitation, g: hourly.wind_gusts_10m, cur: null };
}
async function loadWx(lat, lng) {
  const d = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&hourly=precipitation,wind_gusts_10m&daily=precipitation_sum&past_days=14&forecast_days=7&timezone=Asia%2FShanghai`);
  const today = new Date(Date.now() + BJT_OFF).toISOString().slice(0, 10);
  const ante = (d.daily.time || []).flatMap((dd, i) =>
    dd < today && d.daily.precipitation_sum[i] != null ? [d.daily.precipitation_sum[i]] : []);
  return { fdata: toFdata(d.hourly), soil: AssessCore.soilFromDaily(ante) };
}
async function loadWxArchive(lat, lng, atMs) {
  const s = new Date(atMs - 14 * 86400e3 + BJT_OFF).toISOString().slice(0, 10);
  const e = new Date(atMs + 7 * 86400e3 + BJT_OFF).toISOString().slice(0, 10);
  const d = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}` +
    `&start_date=${s}&end_date=${e}&hourly=precipitation,wind_gusts_10m&daily=precipitation_sum&timezone=Asia%2FShanghai`);
  const cutoff = new Date(atMs + BJT_OFF).toISOString().slice(0, 10);
  const ante = (d.daily.time || []).flatMap((dd, i) =>
    dd < cutoff && d.daily.precipitation_sum[i] != null ? [d.daily.precipitation_sum[i]] : []);
  return { fdata: toFdata(d.hourly), soil: AssessCore.soilFromDaily(ante) };
}

function opt(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function row(city, a, soil) {
  const pg = a.peakGust ? Math.round(a.peakGust.v) + "km/h" : "-";
  const dur = a.durationH != null ? Math.round(a.durationH) + "h" : "-";
  return [city.padEnd(6), String(Math.round(a.closest.dist)).padStart(5) + "km",
    (a.dirF != null ? "" : ""), a.relevant ? "是" : "否",
    String(a.rain).padStart(4) + "mm", String(a.rainPast ?? 0).padStart(4) + "mm",
    soil.w.toFixed(2), pg.padStart(8), String(a.level), a.phase.padStart(8),
    dur.padStart(5), a.longRain ? "⚠ 报" : "—"].join("  ");
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--") &&
  a !== opt("--at") && a !== opt("--cities"));
const tfid = args[0] || "202618";
const at = opt("--at");                       // 2026-07-04T12（北京时）
const sweep = process.argv.includes("--sweep");
const DEFAULT_CITIES = ["杭州市", "上海市区", "宁波市", "南京市", "合肥市",
  "福州市", "武汉市", "广州市", "温州市", "青岛市"];
const cities = opt("--cities") ? opt("--cities").split(",").map((s) => s.trim()) : DEFAULT_CITIES;

const coords = loadCityCoords();
let { name, storm } = await loadStorm(tfid);
const nowMs = at ? new Date(`${at}:00:00+08:00`).getTime() : Date.now();

/* 历史回放的忠实构造：track 只到「当时」，之后的实况充当「完美预报」。
   否则 track 是全程历史，slice(-4) 会取到事件结束后的点、预报是事后最后一期，
   fwdClosest / centerAt / strongSoon 的语义全被破坏（首轮验收实测：回放巴威时
   杭州 closest 变成 902km——因为它的最近点在回放时刻的 1 小时后，被错误的
   「末4点」结构漏掉了）。 */
if (at) {
  const s2 = AssessCore.stormAsOf(storm, nowMs);   // 与事件层同一个「当时所知」构造
  if (s2) storm = s2;
}

console.log(`=== ${name} (${tfid}) · ${at ? "历史回放" : "现在"} ${fmtBJT(nowMs)} 北京时 · [node·与前端同核] ===\n`);
console.log(["城市    ", "  距离", "", "相关", " 过程", " 已下", "土湿", "    阵风", "档", "    阶段", " 持续", " 长雨提示"].join("  "));
console.log("-".repeat(86));

const rows = [];
for (const c of cities) {
  if (!coords[c]) { console.log(`  ${c}: 不在区县库，跳过`); continue; }
  const { lat, lng } = coords[c];
  let wx;
  try { wx = at ? await loadWxArchive(lat, lng, nowMs) : await loadWx(lat, lng); }
  catch (e) { console.log(`  ${c}: 天气拉取失败 ${e.message}`); continue; }
  const a = AssessCore.assess({ loc: { lat, lng }, storm, fdata: wx.fdata,
    soilW: wx.soil.w, obs: null, nowT: nowMs });
  rows.push({ c, lat, lng, wx });
  console.log(row(c, a, wx.soil));
}

const evMode = process.argv.includes("--event");
if (evMode) {
  console.log("\n=== 事件时间线层（assessEvent，与前端同核）===");
  const LV = ["", "①关注", "②准备", "③戒备", "④高危"];
  for (const { c, lat, lng, wx } of rows) {
    const ev = AssessCore.assessEvent({ loc: { lat, lng }, storm, fdata: wx.fdata,
      soilW: wx.soil.w, obs: null, nowT: nowMs });
    if (!ev.samples.length) { console.log(`\n【${c}】不相关，无事件`); continue; }
    // 档位曲线压缩显示：连续同档合并为「档×小时数」
    const runs = [];
    for (const sm of ev.samples) {
      const last = runs[runs.length - 1];
      if (last && last.level === sm.level) last.n++;
      else runs.push({ level: sm.level, n: 1 });
    }
    const stepH = Math.round((ev.samples[1].t - ev.samples[0].t) / 3.6e6);
    const curve = runs.map((r) => `${r.level}×${r.n * stepH}h`).join(" → ");
    console.log(`\n【${c}】事件跨度 ${fmtBJT(ev.spanStart)} ~ ${fmtBJT(ev.spanEnd)}（采样 ${ev.samples.length} 点 / ${stepH}h 步长）`);
    console.log(`  档位曲线: ${curve}`);
    console.log(`  事件峰值: ${LV[ev.peakLevel]}（${ev.peakAt ? fmtBJT(ev.peakAt) : "-"}）  此刻: ${LV[ev.base.level]}  12h前: ${LV[ev.levelPrev12h]}` +
      (ev.peakLevel > ev.base.level ? `  ← 已从峰值回落（「曾${ev.peakLevel}现${ev.base.level}」）` : ""));
    // 一致性自检：峰值必须 ≥ 所有采样与此刻档
    const bad = ev.samples.filter((sm) => sm.level > ev.peakLevel).length;
    if (bad || ev.base.level > ev.peakLevel) console.log(`  ⚠️ 一致性失败：存在高于峰值的采样`);
  }
}

if (sweep) {
  console.log("\n=== 时序稳定性推演（同一城市在不同时刻查看）===");
  for (const { c, lat, lng, wx } of rows.slice(0, 3)) {
    console.log(`\n【${c}】`);
    console.log("  查看时刻            相关   过程    已下    待下  档     阶段");
    for (const dh of [-60, -48, -36, -24, -12, 0, 12]) {
      const ep = nowMs + dh * 3600e3;
      const a = AssessCore.assess({ loc: { lat, lng }, storm, fdata: wx.fdata,
        soilW: wx.soil.w, obs: null, nowT: ep });
      const mark = dh === 0 ? " ←现在" : "";
      console.log(`  ${fmtBJT(ep)}   ${a.relevant ? "是" : "否"}  ${String(a.rain).padStart(4)}mm` +
        `  ${String(a.rainPast ?? 0).padStart(4)}mm  ${String(a.rainFuture ?? 0).padStart(4)}mm` +
        `  ${a.level}  ${a.phase.padStart(8)}${mark}`);
    }
  }
}
