# 猎场 Vantage

Gate.io 合约（BTC / XAU）看盘 + SMC 入场信号通知 + 账户级绩效报表。

## 能做什么

- **看盘页**：K 线 + SMC 结构叠加（BOS / CHoCH、订单块 OB、公允价值缺口 FVG、交易时段框、流动性扫荡）。
- **猎场信号面板**：每分钟扫描，按「1h 背景 → 15m 方向 → 入区 → 5m 同向确认」判定入场，命中后写库并推送 Telegram。
- **报表页**：按模拟账户口径（本金 100U、名义 500U、杠杆 100x、每笔保证金 5U、双边 taker 0.05%）展示期望值、R 倍数分布、周 / 月回撤、信号分层通过率漏斗与逐笔明细。
- **周报**：以报表页展示，不再推送 Telegram。

Telegram 仅作通知，不参与交易执行。

## 技术栈

| 领域 | 选型 |
| --- | --- |
| 后端 | Convex（定时任务、数据库、Secret、HTTP 接口） |
| 前端 | 单文件静态页 + lightweight-charts + GitHub Pages |
| 语言 | TypeScript |
| 回测 | tsx（复用生产判定逻辑） |

## 快速开始

```bash
# 安装依赖
npm install

# 本地 Convex 后端
npm run convex:dev

# 部署后端到生产
npm run convex:deploy

# 本地预览看盘页 / 报表页
python3 -m http.server 8000 --directory ./market-dashboard
```

## 目录

| 路径 | 说明 |
| --- | --- |
| `convex/` | 后端：`battle`（入场信号）、`report`（报表）、`panel`（只读接口）、`luxSmc`/`battleCore`（纯逻辑）、`gate`/`exchanges`（行情）、`telegram`（推送） |
| `market-dashboard/` | 前端：`index.html`（看盘页）、`report.html`（报表页） |
| `backtest/` | 离线回测（复用生产逻辑） |
| `docs/business-logic/` | 业务逻辑总览 |
| `.github/workflows/` | Pages 发布工作流 |

详细业务逻辑见 `docs/business-logic/README.md`。
