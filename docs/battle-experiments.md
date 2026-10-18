# 猎场回测实验日志

口径：扣费后净 R；胜率 = target / (target + stop)，time 退出不进胜负分母。
回测命令：

```bash
npx --yes esbuild backtest/battle6m.ts --bundle --platform=node --format=esm --outfile=/tmp/btq.mjs
BT_DAYS=182 BT_SPANS=6 node /tmp/btq.mjs
```

## 2026-10-17 锚点前移负对照（C）

口径：无窗口内确认1时，用入区前 6 根 15m 的同向内部突破作锚点；配对仍为 5m 30min；衰竭过滤 |入区价 − 锚点结构位| ≤ 1.5×ATR200(15m)。开关 `BT_C=1`，默认关闭。

| 组 | N | 胜率 | avgRnet | sumRnet |
|---|---|---|---|---|
| B 基线 | 95 | 78% | 1.51 | +143.33 |
| C 锚点前移 | 159 | 54% | 0.51 | +81.06 |
| 新增 C−B | 64 | 19% | -0.92 | -58.94 |
| 移除 B−C | 0 | - | - | 0.00 |

新增分散：BTC 25/21%，XAU 39/18%，BOS 33/24%，CHoCH 31/13%。增量胜率 19% < 50%，按预设关闭锚点前移，不调参、不扩样本。

结论：确认1 生成率低是过滤结果，不作为瓶颈处理；停止追信号增量。

## 0.75x 复议

作用域：BTC × sweep=N × BOS，回测加权口径 + 告警执行提示；生产无下单通道。
可接入性：`battleSignals` 已存 `sweep` / `confirmInternal` / `sweepLevel`；`buildMessage` 已接收 `confirmInternal` 与 `sweepSwept`，并由 `sizeNoteOf` 生成整数张提示；告警链无下单通道。
定性：0.75x 为执行规则，形态是告警文案里的仓位提示（人工执行）；回测加权是同一口径的度量。
窗口：自决策日起累计 15–20 笔已了结；不足 15 笔不判。
指标：组内原始 sumR、胜率、0.75x 加权 sumR、Δ总Rnet。

决策树（N ≥ 15）：

1. 原始 sumR > 0 且 胜率 ≥ 50%：取消折价，恢复等权。
2. 原始 sumR > 0 且 胜率 < 50%：维持 0.75x，继续观察。
3. 原始 sumR ≤ 0 且 胜率 < 50%：拦截（乘数 0）。
4. 原始 sumR ≤ 0 且 胜率 ≥ 50%：维持 0.75x，观察尾部亏损。

若维持乘数：先读 `ZONE_BUF_ATR` 入区缓冲语义，再做样本外走样验证；不继续追信号增量。

## 0.75x 复议补充约定

- 数据来源：回测为主，实盘日志为辅；两套分开统计，不混算。
- 告警文案：给具体数量，不给比例。375U / 3.74U 是 2026-10-17 口径快照（本金 100U、每笔名义 500U、保证金 5U、100x）。张数按信号入场价 risk.entry 折算：quanto 0.0001 BTC/张、最小 1 张；示例入场 81,200 → 46 张=373.52U（保证金 3.74U），47 张=381.64U（保证金 3.82U）；文案同时打印参考价，便于人工复算。
- 风险单位：信号止损距离 |entry − stop|，不随乘数变化；R 以该距离归一。
- 重算顺序：先算原始 R，再乘 0.75；不从加权 R 反推原始 R。
- 执行偏差：|实际入场 − 信号入场| / 信号止损距离 > 0.15R 时，复议推迟；偏差持续超标则按实际成交价重算原始 R，再乘 0.75。
- 复议窗口继续跑，N < 15 不判。

## 等待期预期与观察

- 频率与时间：6 个月 9 笔 ≈ 1.5 笔/月；到 N=15 约再 4 个月，到 N=20 约再 7 个月。窗口不会快速关闭，期间按下面两条观察。
- regime 标签：每笔按信号时 1h ATR200 在近 180 天分布中的三分位打标（低/中/高）。复议时先比前 9 笔与新增样本的标签构成；主导档变化，或任一档占比偏移 ≥20pp，则按 regime 分表，不看总数。标签是各自时点的相对分位，180 天窗口随信号滚动、分界值会漂移；分表前先比前后分界值，差异大时按更保守方向解读。
- 子组活跃度：连续 3 个自然月 0 笔 BTC N BOS，记一笔「子组停产」，作为 sweep/扳机在当前波动下系统性不触发的旁证；不改代码，复议时单独列出，不把零信号当作质量稳定。
- 复议顺序：先算执行偏差，>0.15R 先推迟或重算，再进四情形决策树；风险指标仅作辅助。

## 实盘日志格式

最小两列：建议数量、实际数量。CSV 列：

```text
date,symbol,subgroup,sigTs,entry_signal,sl,tp,qty_suggested,qty_actual,entry_ts,entry_actual,exit_actual,result,exit_reason,bars_held,wait_bars,devR,regime,owner,notes
```

sigTs 与 entry_ts 列固定 ISO UTC 5m 开盘，如 `2026-10-15T05:30:00Z`，不做本地时间。

`devR` 按方向计算：long = (entry_actual − entry_signal) / |entry_signal − sl|；short = (entry_signal − entry_actual) / |entry_signal − sl|；正值表示成交更差。

`R` 按实际成交计算：long = (exit_actual − entry_actual) / |entry_actual − sl|；short = (entry_actual − exit_actual) / |entry_actual − sl|；再扣双边 taker 0.001 × entry_actual / |entry_actual − sl|。方向调整只作用于价格差，分母用实际入场到信号止损的距离，与回测 0.1% 双边同口径。

分母保护：|entry_actual − sl| ≤ 0（含入场价已越过止损）时 R 与 devR 记空，result 照实记录，notes 标「口径异常」，该笔不进均值与标准差。

`result` 只取三态：target / stop / time。未执行（未下单）与 gap（推送中断未收到）不写 result，分别单独计数，均不进 N。

`exit_reason` 仅在 `result=time` 时填写（`cancel` 或 `timeout`）；`result=stop/target` 留空。cancel 表示被执行后被取代或区域失效，按取消时向前最近一根已收盘 5m 的收盘价计入（`ltf` 已剔除未收盘 K，非缓存值），result 记 time，notes 注明 cancel。cancel 计入 N；复议时按 exit_reason 拆分 time 退出（cancel / timeout），不与 stop 混算。

`bars_held` = (floor(closedTs/300) − sigTs) / 300，从信号 5m 开盘起算，与回测 FWD_BARS 同一起点；`wait_bars` = (floor(entry_ts/300) − sigTs) / 300 记录 signal→entry 等待，仅作对照说明。未了结两列留空。复议主口径仍用日志 R；仅需与回测对照 R 重算时才用这两列，不作主口径。

了结口径：止损与止盈均按 5m 影线触及，同根先判止损；与回测一致（人工按交易所挂单执行，滑点不建模）。

到期规则：持仓满 288 根 5m（对齐回测 FWD_BARS）仍未触及止损/止盈 → result=time、exit_reason=timeout，按第 288 根收盘了结，计入 N；扫描窗仍为 300 根。

- 非子组：`qty_suggested` 填「—」，不套乘数、不补基准数量。
- regime 回算：不建归档表。取窗 = 信号时点前 180 天 + 200 根 1h 预热（ATR200）；1h K 按 Binance futures klines 的 startTime/endTime 分页回取（1500 根/页），复用回测的 ATR 算法与三分位切点；统一 UTC（sigTs 为 UTC 秒）。复议前用现有 21 条历史信号试跑一次。回算脚本两个断言：① 时基对齐——预热 200 根连续无缺口，末根开盘 = floor(sigTs/3600)×3600，ATR200 非 NaN；② 分位自洽——切点 b1 < b2，21 条标签全部落在 low/mid/high，且与回测同一分位定义。
- 对账键：`gate|symbol|sigTs` 为唯一主键；`battleSignals._id` 降为辅助，仅用于数据库/CLI 排查。sigTs 格式写死为 UTC 5m 开盘 ISO，如 `2026-10-15T05:30:00Z`；库里存秒，看盘页显示本地时间，扫描每分钟一次但只用已收盘 K，同一标的同一 sigTs 最多一条；现有 21 条历史无重复。
- 三计数分开：信号发出数（battleSignals）、实盘执行数（日志行）、已了结数（result 非空）；N 只用「执行且已了结」。
- 推送失败率：按月统计失败数/发送数（发送数取 battleSignals 数），失败写入 `battlePushFailures`（ts / symbol / reason）；单月 >5% 或连续 2 次失败，暂停的是复议窗口的样本计入与计时，扫描和推送继续；缺口期间信号标记 gap 不计入 N，gap 期信号数单独记；窗口时长 = 日历时间 − gap 期时长；恢复后从下一条可对账信号重新起算。每周一 01:00 UTC 自动审计（`auditPushFailures`，查询 `pushFailureStats`），仅命中阈值时推一条监控消息，暂停决策仍人工。失败记录 ts 用毫秒（`Date.now`）；合成记录标 `synthetic=true`，默认统计排除，阳性测试用 `includeSynthetic=true`（已用 2 条合成失败验证 breach=true，默认审计仍 false）。

复议标注规则：

- 风险指标（maxDD / avgRnet）只作辅助，不单独作为维持或取消依据。
- N < 20，或胜率距 50% 不足 10pp，结论标注「待复核」。
- avgRnet < 1.0R，标注「成本敏感」，提示 taker、滑点、资金费未完全计入。
- N ≥ 30 复核与成本口径调整排在复议之后，不现在做。

## 实盘计时与录入

- 计时起点：2026-10-17 22:57 UTC（北京 2026-10-18 06:57），部署完成时间；不从第一条告警起算。
- 部署间空档核对：截至 2026-10-17，`battleSignals` 共 21 条，最新 2026-10-15 05:35 UTC；两次部署（22:57Z / 23:06Z）之间无新增，部署后零新增，作为干净起点证据。
- 张数口径：固定名义优先。qty = max(1, floor(375 / (px × 0.0001)))，notional = qty × px × 0.0001，保证金 = notional / 100；价格变化只改张数，名义目标保持 375U。下限为 1 张：极端价格下 375U 不足 1 张名义时仍取 1 张，实际名义会高于 375U。
- 首条告警人工核对：张数 = floor(375 / (px × 0.0001))，保证金按实际张数折算，子组标签与 SL/TP 齐全（buildMessage 已输出止损与止盈；无 TP 不开仓，target 必不为空）；核对结果记入 notes。
- 录入人：wond03（唯一执行人）；换人时先更新此条目。断档处理：责任人缺位时暂停执行并标注「断档」，不得无主录入；事后补录须在 notes 注明补录时间。


## 复议窗口改动边界（冻结）

判断标准：不修会不会让首条样本记错或不可复议。会 → 现在修；不会 → 记入已知限制，冻结。

放行项（已完成，均为验证）：

- 阳性路径：`backtest/resolveSignal.test.ts` 断言信号根影线目标不计入、影线穿止损计入；运行 `npx tsx backtest/resolveSignal.test.ts`。
- FWD_BARS 锚点：回测 288 根从信号根下一根（j+1）起算；实盘 timeout 同为信号根下一根，cutT = openTs + 288×300。wait_bars > 0 时实盘持仓窗口比回测少 wait_bars 根，timeout 仍锚在信号根。

已知限制（冻结，不修）：

| 项目 | 说明 | 复议时如何处理 |
|---|---|---|
| cancel 的 bars_held | 旧逻辑下 cancel 是唯一 time 路径，可能超过 288 根 | >288 根的 cancel 与 timeout 样本分开看 |
| 扫描窗与 FWD_BARS | 当前 300 ≥ 288，timeout 必被扫到 | 未来改 FWD_BARS 时扫描窗需 ≥ FWD_BARS + 1 |
| entry_ts / exit_ts 对齐 | 根对齐时间，非精确成交/退出时刻 | 分钟级重放不可用；R 与 bars_held 不受影响 |
| 成本口径 | R 扣 0.001 × entry_actual，按入场价近似 | 标注“成本按入场价近似” |
| regime 分界值漂移 | 180 天滚动窗口，前后切点不同 | 分表前先比前后切点，差异大时保守读 |
| N=15–20 统计力弱 | 50% 附近 95% CI 约 ±22–25pp | 低统计力结论标“待复核” |
| bars_held 对照 | 从信号 5m 开盘起算，另有 wait_bars | 对照时用 bars_held，或 bars_held + wait_bars 视锚点 |
| cancel 计入 N | result=time 且 exit_reason=cancel 计入 N | 按 exit_reason 拆分 time 退出，不与 stop 混算 |

解冻条件（仅以下三种允许开新改动）：

1. 首条样本记录错误：张数 / 保证金 / 子组标签 / SL/TP 任一不符预期，阻塞性必修。
2. 推送失败率触发阈值：>5% 或连续 2 次失败，按已有规则暂停样本计入并排查通道。
3. 子组连续 3 个自然月零信号：记“子组停产”，只记录，不改代码。

永久不碰：生产下单通道、实盘 time 退出、回测参数再优化。

除上述情况外，新发现的问题一律写入已知限制，复议窗口关掉后再处理。

## 口径变更：区域失效改用 15m 收盘（2026-10-18 18:35Z）

规则：入区后，任一已收盘 15m K 线收盘越过区域远端（bull 区域收盘 < bottom；bear 区域收盘 > top）即失效。区域窗口仍为 6 小时，入区与去重逻辑不变。判定从 5m 收盘改为 15m 收盘，与区域的定义时基一致。

回测依据（Binance，span=6，6h 窗口）：

| 周期 | 口径 | N | 胜率 | avgRnet | sumRnet |
|---|---|---|---|---|---|
| 182d | 5m 收盘失效 | 94 | 77% | 1.50 | 141.06 |
| 182d | 15m 收盘失效 | 104 | 78% | 1.59 | 165.43 |
| 91d（近半段） | 5m 收盘失效 | 48 | 77% | 1.42 | 68.35 |
| 91d（近半段） | 15m 收盘失效 | 54 | 78% | 1.52 | 82.28 |

两段同向：约 +10% 笔数、+0.1R/笔、+17–20% 总 R。漏斗确认率 12%→17%，A 桶 37%→24%。avgR 的标准误约 0.08，统计上不显著，方向一致性来自时基对齐。

窗口继续拉长无用：15m 失效下 24h 窗口为 106 笔 / 1.55R，与 6h 基本一致，故窗口维持 6h。

上线与回退：2026-10-18T18:35:05Z 部署；此前最后一次部署后零新增信号，故该时间即新口径的干净起点。回退为 `convex/battle.ts` 中 `zoneInvalidateMtf: true` 改回 `false`。

