# WeatherNext 2 接入架构设计

> 状态：等待 Data Request 表单审批邮件。本文档为预先设计，
> 获批后按「上线清单」执行即可。

## 数据集事实（已核实）

- BigQuery 数据集：`weathernext_2_0_0`（Analytics Hub 订阅制，获批后挂到自己的 GCP 项目）
- 0.25° 格点 · **15 天**预报 · 6h 步长 · **64 个集合成员** · 每日 4 次起报（00/06/12/18z）
- 起报后约 7.5h 可查；变量含 10m/100m 风、降水、海平面气压、湿度、温度
- 许可：>48h 历史 = CC BY 4.0；**<48h 实时 = 实验性条款**
  （"experimental modelling only, not validated for real world use"）

## 合规红线（写死在前端展示层）

1. 所有 AI 模式内容标注：**「AI 模式（实验性）· © DeepMind Technologies Limited」**
2. 固定尾注：实验性数据仅供参考，以气象部门发布为准
3. AI 数据永远与官方并列展示，不单独作为结论

## 总体数据流

```
GitHub Actions（cron: 02/08/14/20 UTC ≈ 每次起报+7.5h 后）
  └─ fetcher/weathernext.py
       ├─ 读 docs/data/index.json → 活跃台风及其预报路径
       ├─ 选目标点位：预报路径 500km 内的地级市（通常 20–80 个）
       ├─ BigQuery 点位查询（分区裁剪：仅最新 init_time + 目标格点）
       ├─ 计算集合指标（见下）
       └─ 写 docs/data/ai/summary.json → commit → Pages 自动发布
前端 panel.js
  └─ 用户位置 → 最近目标城市 → 展示 AI 模式行 / 双情景卡
```

设计原则：**前端零查询**（BigQuery 不可能开给浏览器），Actions 预计算，
静态 JSON 分发——延续现有架构，不增加任何运行时依赖。

## 集合指标定义（P0 → P2 分期）

**P0 点位对比（第一版，获批当周上线）**
每目标城市，取 64 成员在未来 15 天的：
- `rain_p10 / p50 / p90`：过程累计雨量三分位 → 时间线显示
  「AI 模式：过程雨量 45~180mm（64 成员中位 90mm，实验性）」
- `gust_p50 / p90`：最大阵风分位
- `hit_prob`：阵风 ≥62km/h（约8级）的成员占比 →「64 个模拟中 N 个预计影响本地」

**P1 双情景卡（分歧可视化）**
- 按「风雨结束时刻」对成员聚类（早/晚两簇）：
  `end_early / end_late / stall_prob`（连续 36h 有雨成员占比）
- 前端：两簇差 >24h 时显示双情景卡——「若快速过境…若停滞…」
- 这直接解决「靠近中，待观察」阶段的远期倾向：官方只有 5 天，AI 有 15 天

**P2 AI 路径线（涡旋追踪）**
- 对集合均值场（或逐成员）做涡旋追踪：区域内海平面气压极小值逐时次连线
- 作为第六条路径加入五机构对比图（虚线+实验性标注）
- 成员路径束 → 未来可做「概率圆锥」

## docs/data/ai/summary.json 合约

```json
{
  "meta": { "init": "2026-07-12T06:00Z", "model": "WeatherNext 2 (experimental)",
            "members": 64, "attribution": "© DeepMind Technologies Limited" },
  "storms": { "<tfid>": {
    "cities": { "温州市": {
      "rain": [45, 90, 180], "gust": [65, 98],
      "hit_prob": 0.27, "stall_prob": 0.11,
      "end_early": "2026-07-13T06", "end_late": "2026-07-14T18"
    } } } }
}
```

## 成本控制

- 只查最新 init_time（分区过滤），只查目标格点（ST_ 或经纬度 BETWEEN），只取所需列
- 估算：80 城 × 64 成员 × 60 时次 × 4 变量 ≈ 千万行级、扫描量远小于 1GB/次
  → 月免费额度（1TB）绰绰有余
- 无活跃台风时跳过查询（零成本待机）

## 上线清单（收到审批邮件后）

1. GCP 建项目（或用现有），开启 BigQuery API 与计费
2. Analytics Hub 接受 WeatherNext 2 listing → 数据集出现在项目里
3. `bq show --schema <project>.<dataset>.weathernext_2_0_0` **核实真实表结构**
   （本设计的查询模板按典型结构假设，列名以实测为准）
4. 建服务账号：角色 BigQuery Job User + 数据集读取；下载 JSON 密钥
5. 仓库 Settings → Secrets 添加 `GCP_SA_KEY` 与 `GCP_PROJECT`
6. 手动触发 `weathernext.yml` workflow → 验证 summary.json 生成
7. 打开 cron；前端 AI 模式行自动出现（panel.js 检测 ai/summary.json 存在即渲染）

## 误差回算的额外红利

>48h 的历史预报是 CC BY 4.0——意味着面 1（预报打分）可以**回补 WeatherNext
的历史成绩**：它 2025 年以来每个台风的预报都可查，AI 模式一上线就自带历史战绩，
不用像五机构那样从零积累。
