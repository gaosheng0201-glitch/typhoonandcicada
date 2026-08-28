#!/usr/bin/env node
/* 台风结束后的自动全审计（定时任务驱动）。

   每场台风停编 ≥72h 后（残涡追踪上限也是 72h，保证事件完整、ERA5 也大概率就绪），
   自动做一次存量核对并把报告入库为公开档案：
   - 影响中国的（轨迹距城市 ≤400km）：挑最近 4 城跑 --audit——逐刻重演「当时用户
     看到什么档、解除条挂不挂」，自检误挂/闪烁/峰值前挂条；
   - 远洋的：抽固定沿海 4 城验「零误报」（应全部「不相关」）。

   审计逻辑不在本文件——它 spawn scripts/sanity_check.mjs（与前端共用 assess-core
   的那把唯一尺子），本文件只做：发现待审台风、选城、驱动、判读输出、归档。
   发现异常时以非零码退出 → GitHub Action 标红，即是通知。

   用法：
     node scripts/audit_storms.mjs                 # 审所有已结束且未审计的
     node scripts/audit_storms.mjs --only 202612   # 只审指定场（重审会覆盖报告）
*/
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_DIR = path.join(ROOT, "docs", "data", "audits");
const require = createRequire(import.meta.url);
const AssessCore = require(path.join(ROOT, "docs", "assess-core.js"));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(ROOT, "docs", "data.js"), "utf-8") + ";globalThis.__T=TyphoonData;", ctx);
AssessCore.configure({ estGaleRadius: ctx.__T.estGaleRadius });
const hav = AssessCore.haversine;

const BJT_OFF = 8 * 3600e3;
const only = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1] : null; })();

/* 城市表 */
const reg = JSON.parse(readFileSync(path.join(ROOT, "docs", "data", "regions.json"), "utf-8"));
const cities = [];
for (const pv of Object.values(reg))
  for (const [city, cv] of Object.entries(pv.cities || {})) cities.push({ city, lat: cv.lat, lng: cv.lng });
const REMOTE_PROBE = ["上海市区", "温州市", "福州市", "深圳市"];   // 远洋零误报抽查点

/* 活跃台风（实时优先，退快照）——活跃/残涡追踪中的不审 */
async function activeTfids() {
  try {
    const r = await fetch("https://typhoon.slt.zj.gov.cn/Api/TyhoonActivity");
    const s = await r.text();
    if (s.trim()) return new Set(JSON.parse(s).map((t) => t.tfid));
  } catch (e) { /* fallthrough */ }
  const idx = JSON.parse(readFileSync(path.join(ROOT, "docs", "data", "index.json"), "utf-8"));
  return new Set((idx.typhoons || []).map((t) => t.tfid));
}

const ptime = (s) => new Date(s.replace(" ", "T") + "+08:00").getTime();

async function main() {
  mkdirSync(AUDIT_DIR, { recursive: true });
  const idxPath = path.join(AUDIT_DIR, "index.json");
  const audIdx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, "utf-8")) : {};
  const active = await activeTfids();

  const files = readdirSync(path.join(ROOT, "docs", "data"))
    .filter((f) => /^typhoon_\d+\.json$/.test(f)).map((f) => f.replace(/^typhoon_|\.json$/g, ""));
  let anyIssue = false, audited = 0;

  for (const tfid of files.sort()) {
    if (only && tfid !== only) continue;
    if (!only && audIdx[tfid]) continue;                       // 已审过
    if (active.has(tfid)) { console.log(`${tfid}: 仍活跃/残涡追踪中，跳过`); continue; }
    const d = JSON.parse(readFileSync(path.join(ROOT, "docs", "data", `typhoon_${tfid}.json`), "utf-8"));
    const track = d.track || [];
    if (track.length < 8) { console.log(`${tfid} ${d.name}: 轨迹过短(${track.length}点)，跳过`); continue; }
    const endMs = ptime(track[track.length - 1].time);
    const hrs = (Date.now() - endMs) / 3.6e6;
    if (hrs < 72) { console.log(`${tfid} ${d.name}: 停编仅 ${Math.round(hrs)}h（<72h），下轮再审`); continue; }

    // 选城：≤400km 最近 4 城 → --audit；否则远洋 → 零误报抽查
    const near = [];
    for (const c of cities) {
      let m = 1e9;
      for (const p of track) { const dd = hav(c.lat, c.lng, p.lat, p.lng); if (dd < m) m = dd; }
      if (m < 400) near.push({ city: c.city, d: m });
    }
    near.sort((a, b) => a.d - b.d);
    const isRemote = near.length === 0;
    const picks = isRemote ? REMOTE_PROBE : near.slice(0, 4).map((x) => x.city);
    const midMs = ptime(track[Math.floor(track.length / 2)].time);
    const at = new Date(midMs + BJT_OFF).toISOString().slice(0, 13);
    const mode = isRemote ? [] : ["--audit"];
    console.log(`\n▶ 审计 ${tfid} ${d.name}（${isRemote ? "远洋·零误报抽查" : "受影响·全时序审计"}）城市: ${picks.join(",")}`);

    let out = "", failed = false;
    try {
      out = execFileSync("node", [path.join(ROOT, "scripts", "sanity_check.mjs"),
        tfid, "--at", at, "--cities", picks.join(","), ...mode],
        { encoding: "utf-8", timeout: 20 * 60e3 });
    } catch (e) { out = (e.stdout || "") + "\n[驱动错误] " + e.message; failed = true; }

    // 判读
    const issues = [];
    if (failed && /接口多次为空/.test(out)) {
      // 无名热带低压等场次 API 无详情接口——不是算法问题，归档为跳过（防止每天重试）
      audIdx[tfid] = { name: d.name, auditedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
                       ok: true, skipped: "数据源无此编号的详情接口", cities: [], remote: isRemote };
      writeFileSync(idxPath, JSON.stringify(audIdx, null, 1));
      console.log("  → 跳过归档：数据源无此编号的详情接口（热带低压类）");
      continue;
    }
    if (failed) issues.push("脚本执行失败");
    if (/⚠️|⚠ 频繁闪烁|峰值出现前就挂条/.test(out)) issues.push("审计自检告警");
    if (/拉取失败/.test(out)) issues.push("天气数据拉取失败");
    if (isRemote) {
      // 远洋：任何一城「相关=是」即误报
      const rel = out.split("\n").filter((l) => /km\s+是\s/.test(l) || /是\s+\d+mm/.test(l));
      if (rel.length) issues.push(`远洋误报 ${rel.length} 城`);
    }
    const ok = issues.length === 0;
    if (!ok) anyIssue = true;

    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const head = [`# 台风审计报告 · ${d.name} (${tfid})`, "",
      `- 结论：${ok ? "✅ PASS" : "⚠️ ISSUES: " + issues.join("；")}`,
      `- 类型：${isRemote ? "远洋（零误报抽查）" : "影响中国（解除态全时序审计）"}`,
      `- 城市：${picks.join("、")}`,
      `- 回放锚点：${at}（北京时，轨迹中点）  · 审计时间：${stamp}`,
      `- 复现：\`node scripts/sanity_check.mjs ${tfid} --at ${at} --cities ${picks.join(",")}${isRemote ? "" : " --audit"}\``,
      "", "```", out.trim(), "```", ""].join("\n");
    writeFileSync(path.join(AUDIT_DIR, `${tfid}.md`), head);
    audIdx[tfid] = { name: d.name, auditedAt: stamp, ok, issues, cities: picks, remote: isRemote };
    writeFileSync(idxPath, JSON.stringify(audIdx, null, 1));
    console.log(`  → ${ok ? "PASS" : "ISSUES: " + issues.join("；")}  报告: docs/data/audits/${tfid}.md`);
    audited++;
  }
  console.log(`\n完成：本轮审计 ${audited} 场${anyIssue ? "，存在告警（退出码 1 → Action 标红）" : ""}`);
  process.exit(anyIssue ? 1 : 0);
}
main();
