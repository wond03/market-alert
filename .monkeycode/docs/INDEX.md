# 猎场 Vantage 文档

## 产品概述

猎场 Vantage 是一个面向 Gate.io 合约（BTC / XAU）的行情看盘与信号通知系统。

系统由三部分组成：

- **看盘页**：单文件静态网页，用 `lightweight-charts` 渲染 K 线与 SMC 结构叠加层（BOS / CHoCH、订单块 OB、公允价值缺口 FVG、时段框、流动性扫荡），并展示作战面板的实时读数与历史信号。
- **作战面板（battle）**：Convex 后端每分钟扫描，用 SMC + lux 结构判定「1h 背景 → 15m 方向 → 入区 → 5m 同向确认」，命中后写入数据库并推送到 Telegram。
- **周报（report）**：每周一汇总近 7 天信号，输出胜率、期望值、回撤与归因结论，推送到 Telegram。

Telegram 仅作通知，不参与任何交易执行。

## 目标用户

- 使用 SMC 结构交易 BTC / XAU 合约的个人交易者。
- 需要「盯盘自动化 + 手机告警 + 阶段性复盘」的自用工具使用者。

## 核心价值

- 一套判定逻辑（`luxSmc` + `battleCore`）同时服务看盘页、后端告警与离线回测，口径一致、可复算。
- 前端只负责显示，计算全部下沉到 Convex，避免前端与后端判定漂移。
- 信号、了结结果、布防状态持久化，支持复盘与周度归因。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `ARCHITECTURE.md` | 系统架构、分层、数据流、技术选型、目录结构 |
| `INTERFACES.md` | Convex 函数签名、数据表结构、外部 API、环境变量、定时任务 |
| `DEVELOPER_GUIDE.md` | 环境准备、本地开发、部署、回测、提交与协作约定 |
| `专有概念/作战面板.md` | 作战面板判定流程与状态机 |
| `专有概念/SMC区域.md` | SMC / lux 结构概念：结构、OB、FVG、均衡线、流动性 |
| `专有概念/周报.md` | 周报数据来源与指标口径 |
| `模块/后端-convex.md` | Convex 后端各模块职责 |
| `模块/看盘页.md` | 前端看盘页结构与行为 |
| `模块/回测.md` | 离线回测脚本与复算口径 |

产品级业务总览另见 `docs/business-logic/README.md`。

## 快速开始

见 `DEVELOPER_GUIDE.md`。核心命令：

```bash
npm install
npm run convex:dev
npm run convex:deploy
```
