# 参与共建

这是一个公益项目：把台风预报翻译成每个人能懂、能行动的信息，让灾害的伤害更小。
不商业化，永远免费无广告。

## 最需要帮助的事（按优先级）

1. **历史对照库扩充**（不需要写代码）：按 `docs/data/analogs.json` 的格式，
   依据《中国气象灾害年鉴》《热带气旋年鉴》和公开报道补充历史台风灾情条目。
   每条须附 `sources` 出处；数值用约数并标 `approx: true`。
   **方法论：以城市为单位补齐（城市×台风）**——先问"这座城市该有哪些台风记忆"，
   再去找记载；比"台风→重灾城市"方向覆盖更均匀，每座城市都该有自己的数据。
   **该补哪座城市、锚点台风是哪几场，看 [`docs/data/analogs-gap.md`](docs/data/analogs-gap.md)**
   （由 `fetcher/build_gap.py` 生成的缺口优先级报告）；批量抽取可用 `fetcher/build_extract.py`
   脚手架（见下文）。
2. **对照库校对**：核对现有条目的雨量、灾情描述是否与来源一致。
3. **代码**：见 README 路线图，重点是残涡追踪、前期降雨上下文、双情景卡。
4. **气象专业把关**：欢迎气象爱好者/从业者指出任何不严谨的表述。

## 对照库数据规范（提交前请通读，CI 会机器校验）

**提交前本地自检：`python3 scripts/validate_analogs.py`**——CI 对每个 PR 运行同一脚本，
不过校验的 PR 不会被合并。规范条文（与校验器一一对应）：

| 字段 | 规则 |
|---|---|
| eventId | `<tfid>-<enName小写去空格>-<city>`，全库唯一 |
| typhoon.tfid | **6 位**：年份4位+编号2位（如 `201909`） |
| region.province | **不带后缀**：`浙江` 而非 `浙江省`；港澳写 `香港`/`澳门` |
| region.city | **地级市名**（区县记载归属地级市：临安→杭州、寿光→潍坊、晋江→泉州）；台湾用现名全称（`高雄市`/`屏东县`，勿用 2010 前旧县名）；省级条目 city 可等于省名 |
| hazard.rainTotalMm | 数字或 null，标 `approx: true`；**没有原文依据就填 null，禁止估** |
| impact.level | 1–4 |
| narrative | ≤90 字人话；**每个数字必须能在 quotes 原文里找到** |
| quotes | 草稿必填（逐字原文片段）；审核合入生产库时由维护者剥离 |
| sources | 必填：`zh.wikipedia: <条目名>` 或 `<媒体名>: <URL>` |

**内容红线（写入 narrative/impact 的文字）**：只写对生活的影响；禁止出现
死亡/遇难/丧生/失踪/伤亡/经济损失/亿元/万元（"提前转移实现无伤亡"类正面表述除外；
quotes 引用原文不受限）。**省级统计不得写成城市数字**——要写就明示"全省"口径。

**审核流程**：新条目一律进 `analogs-draft.json`（`review: "pending"`）→ 维护者对照
quotes 终审 → approved 条目剥离 quotes/review 后合入 `analogs.json`。

**机器辅助抽取的标准流水线**（用 LLM 批量补库时按此执行，缺一不可）：
1. **官方路径定清单**：先用温州台风网接口取该台风完整路径
   （`/Api/TyphoonInfo/<tfid>`，支持历史年份），几何计算 150km 内过境城市——
   用客观清单决定覆盖，而非搜索结果的记载偏好
2. **抽取（Sonnet 级模型）**：每个数字必须逐字来自抓取页面的 quotes；
   抽取后用 grep 在原始网页文本中逐一回查引文存在性；本地宝/地方媒体的
   民生化标题（"台风X几点到某市"）是城市级记载的主要藏身处；区县记载归属地级市
3. **红线正则**：死伤/经济损失字样零容忍（脚本自动扫）
4. **终检（Opus 级模型）**：跨省抽样逐字核对数字、省级口径检查、单位量级检查
   （历史教训：万/千公顷 10 倍错、mm 与级混填、张冠李戴的英文名）
5. **校验器**：`python3 scripts/validate_analogs.py` 全绿才可提交，CI 强制执行
6. **人工终审**：维护者审核 pending 条目后合入生产库

上面这条流水线现在有**可复跑的脚手架** `fetcher/build_extract.py`，把其中的确定性步骤
（第 1 步定清单、抓源、引文回查、第 5 步校验）固化，只剩第 2 步抽取需要人/LLM：

```bash
python3 fetcher/build_extract.py --tfid 201909 --cities    # ① 官方路径 → 150km 内候选城市 + 降雨锚点
python3 fetcher/build_extract.py --tfid 201909 --packets   # ② 抓维基正文 + 吐工作包给 subagent/人工填
python3 fetcher/build_extract.py --verify docs/data/analogs-draft.json  # ④ 引文回查(每个数字须在原文) + 校验器
```

第 2 步「抽取起草」是唯一需要判断力的环节，两种做法：交 LLM subagent 逐个工作包填（免费，
本项目默认）；或 `--extractor api` 直接调 Claude API（Sonnet 起草 / Opus 终检，**会计费，
与零预算取向冲突，仅在需要无人值守时用**）。无论哪种，产出都进 `analogs-draft.json` 等人工终审。

## 自动覆盖主干：城市历史降雨底座

对照库分**两层**，别混用：

- **精品叙事层** = 人工 `analogs.json`：只放有明确原文、值得展示的城市灾情**记忆**，
  走上面的抽取流水线 + 人工终审。它**不承担全国覆盖**，是叙事层和校验集。
- **自动覆盖主干** = 下面两个脚本产出的**客观数据**，保证每座地级市都有底数，
  不靠人工逐条查。前端平静期「你家的台风史」即由它驱动。

```bash
# 缺口矩阵：交叉 IBTrACS × analogs × 沿海 × 行政区，排出「有台风活动却没对照」的城市
python3 fetcher/build_gap.py            # → docs/data/analogs-gap.md（补库优先级看这里）

# 城市×台风客观降雨：官方路径(温州台风网, 同 analogs 的 tfid) × ERA5 逐日降雨
python3 fetcher/build_rain_history.py --from-analogs   # 给 analogs 里所有台风补降雨 → rain-history.json
python3 fetcher/build_rain_history.py 201909 202411    # 或指定 tfid 增量补
```

`build_rain_history.py` 可续跑、增量落盘、带磁盘缓存（`fetcher/.cache/`，已 gitignore），
重跑命中缓存免费。降雨源是 **Open-Meteo Historical(ERA5 再分析)**——免 key、覆盖 1940+、
与前端同源；**已知取舍**：再分析对台风极端峰值偏平滑，数字只作**量级参考**，不等同实测。
台风中心 300km 外的远程降雨（残涡/地形致灾，如郑州型）自动层**按设计不覆盖**，归精品叙事层。
补库前先跑 `build_gap.py` 看该补哪座城市。

## 红线（所有贡献必须遵守）

- 本应用**不发布预警**，只做官方信息的转译、客观计算与历史事实陈列
- 永不输出"不用撤离/肯定没事"类保证；涉撤离一律指向官方通知
- 不确定时宁可保守：风险表述可以比规则更谨慎，不能更乐观
- 所有事实性数字必须有出处，LLM 只用于起草，入库前人工核对
- 对照库只写**对生活的影响**（被淹/停电停水/转移/停工停课/交通中断），
  **不写死伤人数与经济损失**——前者驱动准备，后者只制造恐惧或无关

## 开发

```bash
python3 fetcher/fetch.py            # 抓数据
python3 -m http.server 8642 -d docs  # 本地跑
```

无构建步骤、无依赖。改完刷新浏览器即可。
