# market-alert 业务逻辑总览

> 更新日期：2026-10-16
> 定位：Gate 合约行情看盘 + Telegram 告警。盯 BTC / XAU 两个品种，图表给前端，信号推手机。

## 思维导图

```mermaid
mindmap
  root((market-alert 信号系统))
    数据源
      Gate 合约 REST 与 WSS
      WEEX
      OKX
      品种 BTC XAU
    后端 Convex
      线A 通用行情告警
        rules 规则表
        resolveLevel 关键位
        pollAndCheck 每分钟轮询
        类型 cross_up cross_down breakout
        去重 ruleState scanState
        输出 alerts 表 加 Telegram
      线B 作战面板 battle
        1h 背景偏置
        15m 日内方向
        OB FVG 入区
        统一确认窗口 24 根15m
        5m 触发确认
        buildRisk 止损止盈RR
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
      指标 MACD RSI KDJ
      警报设置弹窗
      作战面板弹窗
      Convex 一次性查询
      GitHub Pages 托管
    研究层 backtest
      battle 窗口对比
      luxsmc smc_seq smc_tf
      session_sweep positioning
      结论 不可实盘
    调度与开关
      cron market poll 每分钟
      cron battle signal 每分钟
      cron weekly report 周一
      env TELEGRAM RULES_SECRET BATTLE
```

若上图未渲染，可直接打开矢量图 [mindmap.svg](./mindmap.svg)。

## 1. 分层总览

| 层 | 模块 | 关键内容 | 说明 | 代码位置 |
|---|---|---|---|---|
| 数据源 | Gate | REST 历史 + WSS 实时（主用） | 作战面板只用 gate | `convex/exchanges.ts:21` |
| 数据源 | WEEX / OKX | REST | 仅告警规则可选 | `convex/exchanges.ts` |
| 数据源 | 品种 | BTC、XAU | 只做这两个 | `convex/exchanges.ts:16` |
| 后端 | 线A 通用告警 | 用户规则轮询推送 | 见下表 2 | `convex/alerts.ts` |
| 后端 | 线B 作战面板 battle | 唯一入场信号 | 见下表 3 | `convex/battle.ts` |
| 后端 | 线C 周报 | battle 近 7 天体检 | 周一推送 | `convex/report.ts` |
| 后端 | 纯逻辑库 | luxSmc / battleCore | 无 Convex 依赖，回测共用 | `convex/luxSmc.ts`、`convex/battleCore.ts` |
| 前端 | 看盘页 | 单文件静态页 | 见下表 6 | `market-dashboard/index.html` |
| 研究层 | backtest | 策略验证 | 不产线，见下表 7 | `backtest/*.ts` |
| 调度 | crons + env | 3 个定时任务 + 开关 | 见下表 5 | `convex/crons.ts` |

## 2. 线A 通用行情告警

| 项 | 内容 | 代码位置 |
|---|---|---|
| 规则存储 | `rules` 表，看盘页写入 | `convex/schema.ts` |
| 规则类型 | `cross_up` / `cross_down` / `breakout` | `convex/rulesAdmin.ts` |
| 关键位 | breakthrough 取前一已结束时段 high/low；cross 取固定 price | `convex/gate.ts:241` `resolveLevel` |
| 轮询 | 每分钟，cross 用 1m、breakout 用 15m 收盘 | `convex/alerts.ts:49` `pollAndCheck` |
| 突破判定 | 实体收盘=body、影线=wick，各推一次 | `convex/gate.ts:295` `scanBreakout` |
| 去重状态 | `ruleState`（side/level/wickDone）、`scanState`（已处理 K） | `convex/market.ts` |
| 输出 | 写 `alerts` 表 + Telegram | `convex/alerts.ts:14` |
| 写入口令 | `RULES_SECRET` | `convex/rulesAdmin.ts` |

## 3. 线B 作战面板 battle（入场信号）

| 步骤 | 内容 | 常量 | 代码位置 |
|---|---|---|---|
| 1 背景 | 1h 结构定 bull/bear/range，反向收盘作废 | `HTF.swing=8` | `battleCore.ts:420` |
| 2 方向 | 15m 摆动 BOS/CHoCH，须日内且带位移 | `DISP_MULT=1.5` | `battleCore.ts:441` |
| 3 入区 | 价格进入顺向 15m OB/FVG | `ZONE_BUF_ATR=0.15` | `battleCore.ts:483` |
| 4 窗口 | 统一确认窗口，5m 收盘穿远端即失效 | `ZONE_WINDOW_BARS=24` | `battleCore.ts:475` |
| 5 确认 | 确认1=15m 内部结构；确认2=5m 触发；须同窗且索引差≤span | `CONFIRM_SPAN_MAX=6` | `battleCore.ts:499` |
| 6 去重 | 同区域当天只推一次 | `firedZone` | `battleCore.ts:505` |
| 7 风控 | entry/stop/target/RR；target 取 RR≥2 的最近对手流动性 | `TARGET_MIN_RR=2`、`STOP_BUF_ATR=0.2` | `battleCore.ts:311` `buildRisk` |
| 落库 | `battleSignals`、`battleOutcomes`、`battleState` | | `convex/battle.ts` |
| 了结回填 | long 收盘≤stop 或最高≥target（short 反向），patch 信号 + 写 outcome | | `convex/battle.ts` `scan` |
| 推送 | 每个新信号一条 Telegram（仅通知） | | `convex/battle.ts` |
| 开关 | `BATTLE=1`（仅 prod） | | `convex/battle.ts` |

## 4. 线C 周报

| 项 | 内容 | 代码位置 |
|---|---|---|
| 数据源 | `battleSignals` 近 7 天（仅 battle） | `convex/report.ts` `reportData` |
| 内容 | 总览 / 按日盈亏(R+%) / 分标的 / 归因(方向·触发·区域) / 风险指标 / 结论建议 | `convex/report.ts` `weeklyReport` |
| 口径 | 止损=-1R；未了结只计数；样本 n<10 提示 | `convex/report.ts` |
| 触发 | cron 周一 01:00 UTC（北京 09:00） | `convex/crons.ts` |
| 手动 | `npx convex run report:weeklyReport --prod` | |

## 5. 数据表 / 定时任务 / 开关

| 类型 | 名称 | 用途 |
|---|---|---|
| 表 | `rules` / `ruleState` / `scanState` | 告警规则与去重 |
| 表 | `alerts` | 已触发告警 |
| 表 | `battleSignals` / `battleOutcomes` / `battleState` | 信号 / 了结 / 布防 |
| cron | `market poll`（1m） | 通用告警轮询 |
| cron | `battle signal`（1m） | 作战面板扫描 |
| cron | `signal weekly report`（周一） | 周报 |
| env | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | 推送 |
| env | `RULES_SECRET` | 规则写入口令 |
| env | `BATTLE`（prod=1） | 作战面板开关 |

## 6. 前端看盘页

| 功能 | 内容 |
|---|---|
| 图表 | 多窗格 K 线（lightweight-charts），交易所 REST 历史 + WSS 实时 |
| 叠加 | BOS/CHoCH、OB、FVG、扫单、时段框 |
| 指标 | MACD、RSI、KDJ 及指标注册表 |
| 弹窗1 | 警报设置（增删规则、启停、写 secret） |
| 弹窗2 | SMC 作战面板（日内方向、最近信号、最近了结、检查清单） |
| 数据 | 一次性 HTTP POST，硬编码 prod Convex URL（非订阅/非轮询） |
| 托管 | GitHub Pages，push `master` 且改 `market-dashboard/**` 触发 |

## 7. 研究层 backtest（不产线）

| 脚本 | 测什么 |
|---|---|
| `battle.ts` | 作战面板统一窗口参数对比 |
| `luxsmc.ts` | LuxAlgo 结构回测 |
| `run.ts` | 4 条规则 + 动量/反转/组合 |
| `smc_seq.ts` / `smc_tf.ts` | SMC 序列化 / 周期缩放回测 |
| `session_sweep.ts` | 时段流动性扫荡 |
| `positioning.ts` | 持仓/多空比条件收益 |
| `history.ts` | 共享：Gate 历史分页 + 缓存 |
| 结论 | 影线逆势≈成本、SMC 扫荡无方向边际，**均不可实盘** |
