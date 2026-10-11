# market-alert

行情价格警报：定时拉取 Gate.io 永续合约行情，命中你设置的条件时推送到 Telegram。

## 它怎么工作

- GitHub Actions 运行 `alerts/check.py`：内置每 5 分钟兜底，另由 cron-job.org 每分钟调用 `workflow_dispatch` 触发一次
- 脚本从 `alerts/config.json` 读取规则，拉取对应合约数据并判定
- **区间扫描**：每次只看「上次运行至今」新增的 1 分钟 K 线，用它们的收盘价判断有没有穿越，所以两次运行之间的短暂穿越也不会漏，且不会重复提醒
- 每条规则每次穿越只提醒一次，价格回到另一侧后重新武装（不会刷屏）
- 各规则的当前「上/下」状态、以及每个合约「已处理到的最新 1 分钟 K 线时间」记录在 `alerts/state.json`，由工作流存进 Actions 缓存（不打进 git，避免每分钟一次提交）

## 触发频率

- 兜底：仓库内 `schedule` 每 5 分钟一次
- 提速：cron-job.org 对下面这个地址每 1 分钟发一次 `POST`，成功返回 `204`
  - `https://api.github.com/repos/wond03/market-alert/actions/workflows/alert.yml/dispatches`
  - 请求头 `Authorization: Bearer <fine-grained PAT>`（该 PAT 需对本仓库有 `Actions: Read and write`）
  - 请求体 `{"ref":"master"}`

## 两种规则类型

### 1. 固定价位 `cross_up` / `cross_down`

| 字段 | 说明 |
| --- | --- |
| `symbol` | Gate.io 合约名，如 `BTC_USDT`、`XAU_USDT` |
| `label` | 推送里显示的名字，如 `BTC` |
| `type` | `cross_up`（上破）或 `cross_down`（下破） |
| `price` | 触发价位 |

示例（BTC 上破 90000 时提醒）：

```json
{ "symbol": "BTC_USDT", "label": "BTC", "type": "cross_up", "price": 90000 }
```

### 2. 指标突破 `breakout`（前一时段 OHLC）

价位不手填，而是由指标算出：取"前一个周期"的开/高/低/收，价格突破该水平时提醒。
周期与看盘页的「前一时段 OHLC」指标一致，均按**北京时间**对齐。

| 字段 | 说明 |
| --- | --- |
| `symbol` | Gate.io 合约名 |
| `label` | 推送显示名 |
| `type` | 固定写 `breakout` |
| `indicator` | 固定写 `prev_ohlc` |
| `tf` | 周期：`15m` / `1h` / `4h` / `1d` |
| `offset` | 回退周期数：`2`=上一个完整周期，`3`=再往前一个。必须 `>= 2` |
| `field` | 用哪个价位做水平：`high` / `low` / `open` / `close` |
| `dir` | `up`（向上突破）/ `down`（向下跌破）|

示例：

```json
{ "symbol": "BTC_USDT", "label": "BTC", "type": "breakout", "indicator": "prev_ohlc", "tf": "1d", "offset": 2, "field": "high", "dir": "up" }
{ "symbol": "XAU_USDT", "label": "XAU", "type": "breakout", "indicator": "prev_ohlc", "tf": "4h", "offset": 2, "field": "low", "dir": "down" }
```

上面第一条：BTC 向上突破"上一日最高价"时提醒。第二条：XAU 向下跌破"上 4 小时最低价"时提醒。

## 修改警报规则

编辑 `alerts/config.json` 的 `rules` 数组，保存提交后下一次定时运行即生效。

## 需要的密钥（Secrets）

在仓库 Settings → Secrets and variables → Actions 里配置：

- `TELEGRAM_BOT_TOKEN`：Telegram 机器人 token
- `TELEGRAM_CHAT_ID`：接收消息的 chat_id

## 手动测试

仓库 Actions 页面 → 左侧 `market-alert` → 右侧 `Run workflow`，即可立即跑一次。
