# market-alert

行情价格警报：定时拉取 Gate.io 永续合约价格，命中你设置的价位时推送到 Telegram。

## 它怎么工作

- GitHub Actions 每 5 分钟运行一次 `alerts/check.py`
- 脚本从 `alerts/config.json` 读取规则，拉取对应合约最新价
- 当价格**上破**或**下破**指定价位时，通过 Telegram 机器人推送
- 每条规则每次穿越只提醒一次，价格回到另一侧后重新武装（不会刷屏）
- 当前各规则的"上/下"状态记录在 `alerts/state.json`，由工作流自动提交

## 修改警报规则

编辑 `alerts/config.json`，`rules` 数组里每条规则：

| 字段 | 说明 |
| --- | --- |
| `symbol` | Gate.io 合约名，如 `BTC_USDT`、`XAU_USDT` |
| `label` | 推送里显示的名字，如 `BTC` |
| `type` | `cross_up`（上破）或 `cross_down`（下破） |
| `price` | 触发价位 |

示例：想让 BTC 上破 90000 时提醒，就加一条
`{ "symbol": "BTC_USDT", "label": "BTC", "type": "cross_up", "price": 90000 }`

保存提交后，下一次定时运行即生效。

## 需要的密钥（Secrets）

在仓库 Settings → Secrets and variables → Actions 里配置：

- `TELEGRAM_BOT_TOKEN`：Telegram 机器人 token
- `TELEGRAM_CHAT_ID`：接收消息的 chat_id

## 手动测试

仓库 Actions 页面 → 左侧 `market-alert` → 右侧 `Run workflow`，即可立即跑一次。
