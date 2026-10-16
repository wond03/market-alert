# 模块：后端（convex/）

Convex 后端承担定时扫描、信号与状态持久化、只读查询、周报聚合与 Telegram 推送。

部署：prod 环境 `efficient-cod-911`（`https://efficient-cod-911.convex.cloud`）。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `schema.ts` | 定义 `battleState` / `battleSignals` / `battleOutcomes` 三张表及索引 |
| `crons.ts` | 两个定时任务：每分钟扫描、每周一周报 |
| `battle.ts` | 线B：扫描判定、信号入库、了结回填、只读查询 |
| `battleCore.ts` | 作战面板纯逻辑：区域筛选、双确认、风控 `buildRisk`、消息渲染 |
| `luxSmc.ts` | SMC / lux 结构计算纯逻辑（见 `专有概念/SMC区域.md`） |
| `panel.ts` | 看盘页只读接口 `analyze` / `battleStatus`，无 DB |
| `report.ts` | 线C：周报数据查询与推送 |
| `gate.ts` | 时段 / 时间 / 价格格式化工具（纯函数） |
| `exchanges.ts` | Gate 行情适配：合约映射与 K 线获取归一化 |
| `telegram.ts` | `sendTelegram` 推送封装 |

`convex/_generated/` 为 Convex 自动生成的绑定，勿手改。

## battle.ts

- `EXCHANGE = "gate"`，`SYMBOLS = ["BTC","XAU"]`。
- `scan`（internalAction）：`BATTLE!=1` 跳过；遍历标的拉 1h/15m/5m K 线 → `evaluateBattle` → 命中则入库并推送；同时检查上一笔未了结信号是否被取代或了结。
- 辅助：`env(name)`、`rrOf(...)`、`resolveSignal(...)`（在 5m K 线上判断是否触及止损 / 止盈）。
- 公开只读：`recentBattleSignals`、`recentBattleOutcomes`。

## panel.ts

- `analyze`：返回 `{swing, internal, fvgs, trail, eq}`，供看盘页绘制结构叠加层。
- `battleStatus`：按当前三周期 K 线实时复算，逐区返回触发阶段（`no-zone` / `invalid` / `in-zone` / `c1` / `c2` / `confirmed`）与距离读数。
- 入参 `candleArg` 的 `v` 可选，缺省按 0 处理。

## gate.ts

纯工具模块，无 Convex 函数：

- 时段定义 `SESSIONS`：亚洲盘（Asia/Tokyo 09:00–15:00）、伦敦盘（Europe/London 08:00–16:30）、纽约盘（America/New_York 09:30–16:00）。
- `currentSessionName`、`currentDayStart`、`currentSessionWindow`、`lastClosedSessionWindow`。
- `fmtPrice`、`fmtBeijing`（北京时间展示）。

## exchanges.ts

- `GATE_BASE = "https://api.gateio.ws/api/v4"`，`SYMBOLS` 映射 `BTC→BTC_USDT`、`XAU→XAU_USDT`。
- `contractOf(exchange, symbol)`、`getCandles(exchange, contract, interval, limit=1000)`。
- 归一化：过滤非法值、按 `t` 升序、去重。

## telegram.ts

- `sendTelegram(text)`：`POST .../sendMessage`，`parse_mode=HTML`，关闭链接预览。
- 令牌或会话缺失时打印告警并静默跳过。
