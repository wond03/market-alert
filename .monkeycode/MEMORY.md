# User Instruction Memory

记录用户指令与项目知识（操作/构建/排查/工作流/环境）。格式：Date / Context / Category / Instructions。新增前先去重、合并同类；可从代码直接读到的细节（函数/表/参数/逻辑）不记。

## 用户指令

- 仓库维护（2026-10-12~14）：本仓库 `wond03/market-alert`（public）由 Agent 维护，改动推 `master`；`market-dashboard/**` 变更后 Pages 自动重部署；仓库是页面托管与源码唯一存放处。
- 安全：禁止任何密钥/口令入库（`RULES_SECRET`、`TELEGRAM_BOT_TOKEN`、各类 API key），`.env.local` 已 gitignore，推送前自查。
- 策略定位：只做 BTC + XAU，质量优先，15m 日内交易，日内 2~3 信号即合理；优化方向是补高周期/背景信息，不加品种、不提频率。
- 研发方式：新功能先在 GitHub 搜现成开源复用（skill `oss-first`），不足再自研。
- 简介（2026-10-17）：每个产品/项目维护一份一页以内简介（本项目 = 根 `README.md`），代码改动后同步；业务细节见 `docs/business-logic/README.md`。

## 项目知识（环境配置 / 操作部署 / 排查 / 工作流）

- 部署：Convex 团队 `2079362703`，dev `adventurous-sardine-576`、prod `efficient-cod-911`；env 按部署隔离。看盘页 GitHub Pages `https://wond03.github.io/market-alert/`（`.github/workflows/pages.yml` 发布 `market-dashboard/`）。本地预览 `python3 -m http.server 8000 --directory ./market-dashboard`。实时行情走 Gate 期货 WSS `wss://fx-ws.gateio.ws/v4/ws/usdt`。
- Convex 常用：登录 `npx convex login --no-open --login-flow poll`；推代码 dev `npx convex dev --once`、prod `npx convex deploy`；跑函数 `npx convex run <module>:<fn> [--prod]`（路径必须用冒号）；env `npx convex env set|get NAME [--prod]`。前端经 HTTP API `POST https://<dep>.convex.cloud/api/{query|mutation|action}`，body `{"path":"module:fn","args":{},"format":"json"}`；prod 自定义错误须用 `ConvexError`（`throw Error` 会被脱敏成 Server Error）。
- 前端依赖后端：看盘页 SMC 叠加/盘面读数/猎场信号面板读数全部走 `convex/panel.ts`（`panel:analyze` / `panel:battleStatus`）；改前端后必须 `npm run convex:deploy`，否则报接口不存在。
- 推送 GitHub：全局 credential helper 对 github.com 返回 500，须覆盖 `git -c credential.helper= -c credential.helper='!gh auth git-credential' push`；`gh` 账号 `wond03`（推 `.github/workflows/` 需 `workflow` scope）。
- Telegram：本环境无法稳定访问 `api.telegram.org`（TLS reset，curl exit 35），收发验证须放到 GitHub Actions runner 执行。
- 回测：脚本在 `backtest/`，运行 `./node_modules/.bin/esbuild backtest/<f>.ts --bundle --platform=node --format=esm --outfile=/tmp/x.mjs && node /tmp/x.mjs`（直接 import `convex` 判定函数，保证与生产同逻辑）。Gate K 线：单次 ≤2000 根、`limit` 不与 `from`/`to` 同用、仅最近 10000 点（15m≈104 天）。结论：早期影线 / SMC 扫荡变体无优势、不可实盘；生产 battle 组合口径近 31 天 21 笔、71% 胜、净 +1.63R/笔（时间前后半段均正），详见 `docs/business-logic/README.md` §8。
- 工具 / 环境：全局 skill 在 `~/.config/opencode/skills/`（用 `skill-creator` 脚手架，校验器仅允许 frontmatter `name/description/license/metadata/allowed-tools`）。opentoken 插件会压缩大输出：`read`/`grep`/`glob` 超 5 行 / 512 字节卸载为摘要（原文 `~/.config/opentoken/offload/<id>.txt`），bash 大输出做符号压缩（`$N=` 图例）——用 `node -e` 按行号打印小片段最稳，改大 HTML 用 node 补丁脚本按行号增删。
- 平台规则注入（2026-10-16 发现）：`~/.config/opencode/opencode.json` 的 `instructions` glob 与 `rules/*.md` 由平台**每次会话重写**（mtime = 会话开始，内容源自 `tasks/<id>.json` 的 `execution_config.configFiles`），容器内移动/改动不持久；要精简须改 MonkeyCode 平台项目设置。
- 已弃用链路（勿再引用）：旧 GitHub Actions Python 告警、`convex/smc.ts`+`smcCore.ts`、`convex/mtfSmc.ts`、`convex/paper.ts`、通用告警（`rules`/`alerts` 表、`market poll` cron、WEEX/OKX）、`report:weeklyReport` + `signal weekly report` cron（已改为 `report:pageData` + `report.html`）。猎场信号面板判定细节见 `convex/battleCore.ts`。
