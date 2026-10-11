# market-alert

行情价格警报：定时拉取 Gate.io 永续合约行情，命中你设置的条件时推送到 Telegram。

## 它怎么工作

- GitHub Actions 每 5 分钟运行一次 `alerts/check.py`
- 脚本从 `alerts/config.json` 读取规则，拉取对应合约数据并判定
- 命中时通过 Telegram 机器人推送；每条规则每次穿越只提醒一次，价格回到另一侧后重新武装（不会刷屏）
- 各规则的当前"上/下"状态记录在 `alerts/state.json`，由工作流自动提交

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
| `tf` | 周期：`1h` / `4h` / `1d` |
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
