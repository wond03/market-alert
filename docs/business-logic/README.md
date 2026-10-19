# 猎场 Vantage 业务逻辑总览

> 更新日期：2026-10-19
> 定位：猎场 Vantage — Gate 合约行情看盘 + Telegram 告警 + WEEX 模拟盘自动下单。盯 BTC / XAU 两个品种，图表给前端，信号推手机。

## 思维导图

```mermaid
mindmap
  root((猎场 Vantage 信号系统))
    数据源
      Gate 合约 REST 与 WSS
      品种 BTC XAU
    后端 Convex
      猎场信号面板 battle
        1h BOS 定方向 摆动4
        1h OB 定区域 摆动4
        15m FVG 入场
        15m 扫荡后 BOS 硬条件
        15m 右侧确认 6h 窗口 60m 触发
        buildRisk 止损止盈RR
        交易所止损止盈条件单
        表 battleSignals battleOutcomes battleState
        了结回填结果
        Telegram 通知
      线C 周报 report
        每周一 北京上午9点
        battle 近7天体检
        总览 盈亏 归因 风险 结论
      纯逻辑库
        luxSmc 结构计算
        battleCore 决策状态机
    前端 看盘页
      多窗格 K 线
      SMC 叠加
      指标注册表 交易时段
      猎场信号面板弹窗
      Convex 一次性查询
      GitHub Pages 托管
    研究层 backtest
      battle 窗口对比
      history 历史抓取
      结论 不可实盘
    调度与开关
      cron battle signal 每分钟
      cron weekly report 周一
      env TELEGRAM BATTLE
```

## 1. 分层总览

| 层 | 模块 | 关键内容 | 说明 | 代码位置 |
|---|---|---|---|---|
| 数据源 | Gate | REST 历史 + WSS 实时（主用） | 猎场信号面板只用 gate | `convex/exchanges.ts:21` |
| 数据源 | 品种 | BTC、XAU | 只做这两个 | `convex/exchanges.ts:16` |
| 后端 | 猎场信号面板 battle | 唯一入场信号 | 见下表 2 | `convex/battle.ts` |
| 后端 | 线C 周报 | battle 近 7 天体检 | 周一推送 | `convex/report.ts` |
| 后端 | 纯逻辑库 | luxSmc / battleCore | 无 Convex 依赖，回测共用 | `convex/luxSmc.ts`、`convex/battleCore.ts` |
| 后端 | 看盘只读接口 | panel:analyze / panel:battleStatus | 看盘页唯一计算入口 | `convex/panel.ts` |
| 前端 | 看盘页 | 单文件静态页 | 计算走后端 panel:*，见下表 5 | `market-dashboard/index.html` |
| 研究层 | backtest | 策略验证 | 不产线，见下表 6 | `backtest/*.ts` |
| 调度 | crons + env | 2 个定时任务 + 开关 | 见下表 4 | `convex/crons.ts` |

## 2. 猎场信号面板 battle（入场信号）

| 步骤 | 内容 | 常量 | 代码位置 |
|---|---|---|---|
| 1 方向 | 1h 摆动结构（摆动 4）最近 BOS 定 bull/bear，反向收盘作废 | `HTF.swing=4` | `battleCore.ts:21` `:590` |
| 2 区域 | 只用 1h 顺向未失效 OB（摆动 4） | `ZONE_BUF_ATR=0.15` | `battleCore.ts:237` `:614` |
| 3 入场 | 入区后新形成的 15m 同向 FVG 内入场；不要求与 OB 重叠；未出现 FVG 时继续等待 | `ZONE_BUF_ATR=0.15` | `battleCore.ts` `inEntry` |
| 4 扫荡BOS | 15m 先扫前摆动点，12 根内出现同向 BOS 或 MSS/CHoCH，作为区域有效性硬条件 | `SWEEP_LOOKBACK=20`、`SWEEP_BOS_SPAN=12` | `battleCore.ts:36` `:401` |
| 5 右侧 | 最近一根收盘 15m 须顺势；与入场同完成 | — | `battleCore.ts:664` |
| 6 窗口 | 首次进入 OB 后持续跟踪，不设固定时间上限；15m 收盘穿过远端或方向变化才退出 | — | `battleCore.ts` `zoneInvalidated` |
| 7 去重 | 同区域只推一次；失效后价格回来可重新布防 | `firedZone` | `battleCore.ts:684` |
| 8 风控 | entry=OB 近端，stop=远端±0.2ATR；target 取 RR≥2 的最近对手流动性 | `TARGET_MIN_RR=2`、`STOP_BUF_ATR=0.2` | `battleCore.ts:426` `buildRisk` |
| 落库 | `battleSignals`、`battleOutcomes`、`battleState` | | `convex/battle.ts` |
| 了结回填 | long 收盘≤stop 或最高≥target（short 反向），patch 信号 + 写 outcome | | `convex/battle.ts` `scan` |
| 推送 | 每个新信号一条 Telegram，并触发 WEEX 市价单；成交后挂交易所止损/止盈条件单 | | `convex/battle.ts`、`convex/weex.ts` |
| 开关 | `BATTLE=1`、`WEEX_AUTO=1`（仅 prod） | | `convex/battle.ts`、`convex/weex.ts` |

## 3. 线C 周报

| 项 | 内容 | 代码位置 |
|---|---|---|
| 数据源 | `battleSignals` 近 7 天（仅 battle） | `convex/report.ts` `reportData` |
| 内容 | 总览 / 按日盈亏(R+%) / 分标的 / 归因(方向·触发·区域) / 风险指标 / 结论建议 | `convex/report.ts` `weeklyReport` |
| 口径 | 止损=-1R；未了结只计数；样本 n<10 提示 | `convex/report.ts` |
| 触发 | cron 周一 01:00 UTC（北京 09:00） | `convex/crons.ts` |
| 手动 | `npx convex run report:weeklyReport --prod` | |

## 4. 数据表 / 定时任务 / 开关

| 类型 | 名称 | 用途 |
|---|---|---|
| 表 | `battleSignals` / `battleOutcomes` / `battleState` | 信号 / 了结 / 布防 |
| cron | `battle signal`（1m） | 猎场信号面板扫描 |
| cron | `signal weekly report`（周一） | 周报 |
| env | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | 推送 |
| env | `BATTLE`（prod=1） | 猎场信号面板开关 |
| env | `WEEX_AUTO`、`WEEX_MARGIN_USDT`、`WEEX_LEVERAGE`、`WEEX_BASE_URL` | WEEX 模拟盘自动下单与交易所止损止盈 |

## 5. 前端看盘页

| 功能 | 内容 |
|---|---|
| 图表 | 多窗格 K 线（lightweight-charts），交易所 REST 历史 + WSS 实时 |
| 叠加 | BOS/CHoCH、OB、FVG、扫单、时段框（数据来自 `panel:analyze`） |
| 指标 | 指标注册表 `IND`，当前仅“交易时段” |
| 弹窗 | SMC 猎场信号面板（日内方向、最近信号、最近了结、检查清单；读数来自 `panel:battleStatus`） |
| 数据 | 一次性 HTTP POST，硬编码 prod Convex URL（非订阅/非轮询） |
| 托管 | GitHub Pages，push `master` 且改 `market-dashboard/**` 触发 |

## 6. 回测

| 脚本 | 用途 |
|---|---|
| `backtest/battle.ts` | 用生产同口径 `evaluateBattle` 复算猎场信号面板 |
| `backtest/history.ts` | 共享：Gate 历史分页 + 缓存 |

原研究层脚本（`luxsmc`/`run`/`smc_seq`/`smc_tf`/`session_sweep`/`positioning`）与生产策略无关，已于 2026-10-16 移除。

## 7. 猎场信号面板回测验收（2026-10-16）

工具 `backtest/battle.ts`（复用生产 `evaluateBattle`；MTF 15m / LTF 5m；前瞻 24h；net 已扣 10bps 往返）。
样本 Gate `BTC`/`XAU` 5m 近 ~31 天（09-14 → 10-15）。回测时旧口径 = 窗口 24 根 15m、span 6，未含 60 分钟触发上限与右侧确认。

| 指标 | 值 |
|---|---|
| 成交 | 21（BTC 8 / XAU 13） |
| 胜率 | 71%（15 胜 / 6 负） |
| 净期望 | +1.63 R/笔 |
| 累计净 | +34.28 R |
| 前半段 | 10 笔，70% 胜，+14.38 R |
| 后半段 | 11 笔，73% 胜，+19.90 R |

参数敏感性（同一样本）：窗口 8/12/24 × span 3/6/9 净期望均为正（+0.76～+1.63 R/笔），仅 XAU 窗口 8 略负（-0.06 R/笔，n=4）。

结论：生产 battle 组合（位移过滤 + 双层确认 + 结构止损/流动性止盈）在近 1 个月、扣成本、时间前后半段各自为正。旧结论「SMC 变体均不可实盘」测的是泛化变体，本次测的是生产组合口径，两者不矛盾。

局限：样本仅 ~31 天 / 21 笔（Gate 5m 历史上限）；止盈取最近对手流动性，收益集中于少数远目标（rr 均值 4.7、最大 13.1）；止损按 -1R 记账、未含跳空滑点，略偏乐观。待办：更长样本 / 多市场状态复核。
