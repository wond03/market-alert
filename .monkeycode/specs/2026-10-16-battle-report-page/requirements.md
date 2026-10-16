# Requirements Document

## Introduction

将猎场信号面板（battle）的绩效复盘从 Telegram 周报改造为**独立静态报表页** `report.html`，按**模拟账户口径**展示信号质量（分层通过率漏斗）、期望值、R 倍数分布、周 / 月回撤，以及每笔对应的仓位、杠杆、保证金与手续费。

本需求不改变既有入场判定逻辑与风控（`buildRisk`），仅改变「记录什么」与「如何展示」。

## Glossary

- **猎场信号面板信号（Signal）**：`battleSignals` 中已确认并入库的入场信号。
- **区域（Zone）**：猎场信号面板认定的合格 OB / FVG 区间。
- **漏斗层级（Stage）**：`入区 → 确认1 → 确认2 → 入场`；另有「失效」终止态。
- **名义（Notional）**：每笔模拟仓位规模，取值 `500 USDT`。
- **杠杆（Leverage）**：取值 `100x`。
- **每笔保证金（Margin）**：取值 `5 USDT`（`名义 / 杠杆`）。
- **账户本金（Principal）**：取值 `100 USDT`。
- **手续费（Fee）**：`名义 × 0.05% × 2`（双边，taker，不加滞点）。
- **R**：以止损风险为单位的收益度量，止损为 `-1R`。
- **期望值（Expectancy）**：每笔平均净 R（扣手续费后）。
- **回撤（Drawdown）**：模拟账户权益曲线的最大回落，按周（7 天）与月（30 天）两个窗口计算。

## Requirements

### Requirement 1：独立报表页

**User Story：** AS 交易者，I want 一个独立报表页，so that 我能在浏览器查看猎场信号面板的账户级绩效。

#### Acceptance Criteria

1. 系统 SHALL 在 `market-dashboard/` 下提供静态文件 `report.html`，并随现有 Pages 工作流发布。
2. WHEN 用户打开 `report.html`，系统 SHALL 通过 Convex 只读接口拉取聚合数据并渲染。
3. IF 数据接口请求失败，THEN 系统 SHALL 在页面上显示错误提示。
4. 系统 SHALL 在报表页展示数据覆盖的时间区间。

### Requirement 2：分层通过率漏斗

**User Story：** AS 交易者，I want 看到信号在哪一层被淘汰，so that 我能定位过滤条件是否过严。

#### Acceptance Criteria

1. WHILE 猎场信号面板扫描运行，系统 SHALL 记录每个区域在各层级的通过或失败事件（入区、确认1、确认2、入场、失效）。
2. 系统 SHALL 为每个层级记录事件计数，字段包含交易所、标的、区域指纹、层级、结果与时间戳。
3. 报表页 SHALL 展示各层的通过数、淘汰数与该层通过率。
4. 报表页 SHALL 展示从入区到入场的整体通过率。
5. WHILE 同一区域在确认窗口内多次被评估，系统 SHALL 对同一区域同一层级只记录一次事件。

### Requirement 3：绩效指标

**User Story：** AS 交易者，I want 看到期望值与 R 倍数分布，so that 我能评估策略的收益质量。

#### Acceptance Criteria

1. 报表页 SHALL 展示已了结笔数、盈亏笔数、胜率、期望值（R/笔）、累计 R。
2. 报表页 SHALL 展示 R 倍数分布（按区间分桶：`≤-1`、`(-1,0)`、`[0,1)`、`[1,2)`、`[2,3)`、`≥3`）。
3. 报表页 SHALL 按方向、触发类型、区域类型分别展示期望值。
4. 期望值 SHALL 在扣除双边手续费后计算。

### Requirement 4：周 / 月回撤

**User Story：** AS 交易者，I want 同时看到周与月回撤，so that 我能判断回撤的时间尺度。

#### Acceptance Criteria

1. 报表页 SHALL 以账户本金为基准，展示近 7 天的最大回撤。
2. 报表页 SHALL 以账户本金为基准，展示近 30 天的最大回撤。
3. 回撤 SHALL 同时以 R 与账户本金百分比两种口径给出。
4. 系统 SHALL 基于已了结交易的累计权益曲线计算回撤。

### Requirement 5：模拟账户口径

**User Story：** AS 交易者，I want 每笔映射到明确的仓位与成本，so that 我能对账到真实账户。

#### Acceptance Criteria

1. 系统 SHALL 以名义 `500 USDT`、杠杆 `100x`、每笔保证金 `5 USDT` 计算每笔仓位。
2. 系统 SHALL 以单边 taker `0.05%`、双边计费的方式计算每笔手续费。
3. 报表页 SHALL 展示每笔的仓位、杠杆、保证金与手续费。
4. 报表页 SHALL 展示账户本金、账户权益曲线与（扣费后）累计收益百分比。
5. 报表页 SHALL 展示每笔的账户口径风险（即 1R 占账户本金的百分比）。

### Requirement 6：周报去 Telegram 化

**User Story：** AS 交易者，I want 周报只在页面查看，so that 我不再被例行推送打扰。

#### Acceptance Criteria

1. 系统 SHALL 停止通过 Telegram 推送周报。
2. 系统 SHALL 保留猎场信号面板入场信号的 Telegram 推送。
3. 系统 SHALL 移除「周报」对应的定时任务与推送动作。

### Requirement 7：数据查询

**User Story：** AS 前端，I want 一次调用拿到报表数据，so that 页面渲染简单可靠。

#### Acceptance Criteria

1. 系统 SHALL 提供一个只读接口返回报表页所需的全部聚合数据（漏斗、指标、R 分布、回撤、账户明细）。
2. 该接口 SHALL 接受时间窗口参数（用于 7 天 / 30 天）。
3. 该接口 SHALL 不写入任何数据。
