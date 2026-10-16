# 接口文档

## Convex 函数

### battle（`convex/battle.ts`）

| 函数 | 类型 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- | --- |
| `scan` | internalAction | 无 | `{skipped?:true}` 或 `{fired:number}` | 每分钟扫描 BTC / XAU，判定入场、入库、推送；`BATTLE!=1` 时跳过 |
| `insertSignals` | internalMutation | `{signals: Signal[]}` | `Id[]` | 批量写入 `battleSignals` |
| `closeSignal` | internalMutation | `{id, result, exitPrice, closedTs}` | 无 | 回填信号的 `result`/`exitPrice`/`closedTs` |
| `insertOutcome` | internalMutation | `{exchange, symbol, bias, entryPrice, stopPrice, targetPrice, rr, openedTs, closedTs, result, exitPrice, createdAt}` | 无 | 写入 `battleOutcomes` |
| `recentBattleSignals` | query | `{limit?}` | `Signal[]` | 按 `sigTs` 倒序取最近信号（默认 50） |
| `recentBattleOutcomes` | query | `{limit?}` | `Outcome[]` | 按 `closedTs` 倒序取最近了结（默认 100） |

`Signal` 字段：`exchange, symbol, bias, bg?, htfTag, htfLevel, zoneKind, zoneTop, zoneBottom, confirm, confirmInternal?, entryPrice, stopPrice, targetPrice, rr, sweep?, sweepLevel?, sigTs, text, createdAt, result?, exitPrice?, closedTs?`。

### panel（`convex/panel.ts`）

| 函数 | 类型 | 参数 | 返回 |
| --- | --- | --- | --- |
| `analyze` | action | `{candles: Candle[], swing?, internal?}` | `{swing, internal, fvgs, trail, eq}` |
| `battleStatus` | action | `{htf: Candle[], mtf: Candle[], ltf: Candle[], now: number}` | 每区间的触发阶段与距离读数 |

`Candle = {t,o,h,l,c,v?}`（`v` 可选，缺省为 0）。两个接口均无数据库读写。

### report（`convex/report.ts`）

| 函数 | 类型 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- | --- |
| `reportData` | internalQuery | `{since:number}` | `{openedTs:number[], closed:Trade[]}` | 读 `battleSignals`（`sigTs >= since`） |
| `weeklyReport` | internalAction | 无 | `{skipped?:true, sent?:true}` | `BATTLE!=1` 跳过；否则汇总并推送 |

## 数据表

### battleState

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | `交易所:标的`，唯一索引 `by_key` |
| `firedZone` | string | 最近已推送的区域指纹，空串表示可重新布防 |
| `zoneKey` | optional(string) | 当前跟踪区域指纹 |
| `zoneStartT` | optional(number\|null) | 确认窗口起点（首次入区的 5m K 开盘时间） |
| `openDir` | optional(string\|null) | 未了结信号方向 `long`/`short` |
| `openEntry` / `openStop` / `openTarget` | optional(number\|null) | 未了结信号入场 / 止损 / 止盈 |
| `openTs` | optional(number\|null) | 未了结信号触发时间 |
| `openSignalId` | optional(Id\|null) | 对应 `battleSignals` 记录 |
| `updatedAt` | number | 更新时间 |

### battleSignals

索引 `by_sigTs(sigTs)`。字段见上方 `Signal`。

### battleOutcomes

索引 `by_closedTs(closedTs)`。字段：`exchange, symbol, bias, entryPrice, stopPrice, targetPrice, rr, openedTs, closedTs, result(stop|target|cancel), exitPrice, createdAt`。

## 外部 API

### Gate.io（`convex/exchanges.ts`、前端）

- REST 基址：`https://api.gateio.ws/api/v4`
- 合约映射：`BTC → BTC_USDT`，`XAU → XAU_USDT`
- `getCandles(exchange, contract, interval, limit=1000)`：拉取并归一化（按 `t` 升序、去重、过滤非法值）。
- 前端另有 WebSocket `wss://fx-ws.gateio.ws/v4/ws/usdt` 用于实时增量；前端还保留 WEEX / OKX 备选 REST 适配器。

### Telegram（`convex/telegram.ts`）

- `sendTelegram(text)` → `POST https://api.telegram.org/bot<TOKEN>/sendMessage`，`parse_mode=HTML`，关闭链接预览。
- 未配置令牌或会话时告警并跳过，不抛错。

## 环境变量

| 变量 | 使用者 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | telegram.ts | Telegram 机器人令牌 |
| `TELEGRAM_CHAT_ID` | telegram.ts | 推送目标会话 |
| `BATTLE` | battle.ts / report.ts | `1` 启用告警链路 |

## 定时任务（`convex/crons.ts`）

| 名称 | 频率 | 目标 |
| --- | --- | --- |
| battle signal | `interval` 每分钟 | `internal.battle.scan` |
| signal weekly report | `weekly` 周一 01:00 UTC | `internal.report.weeklyReport` |
