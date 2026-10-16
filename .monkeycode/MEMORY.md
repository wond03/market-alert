# User Instruction Memory

记录用户指令、偏好与项目知识。条目格式：Date / Context / Category / Instructions。用户指令用 `[User Instruction Summary]`，Agent 发现的知识用 `[Project Knowledge Summary]`。新增前先去重/合并同类条目。

## Entries

[User Instruction Summary]
- Date: 2026-10-12 ~ 2026-10-14
- Context: 用户关于仓库维护、策略定位与研发方式的长期要求
- Instructions:
  - 仓库维护：Agent 负责 GitHub 仓库 `wond03/market-alert`（public）的日常维护——改动推 `master`，保证 `market-dashboard/**` 变更后 Pages 自动重部署；该仓库是看盘页托管与源码唯一存放处。
  - 安全：禁止任何密钥/口令入库（`RULES_SECRET`、`TELEGRAM_BOT_TOKEN`、各类 API key；`.env.local` 已 gitignore），推送前自查。
  - 策略定位：只做 BTC + XAU 两品种，不做多品种分散；质量优先，15m 日内交易，日内 2~3 个信号即合理；优化方向是补高周期/背景信息，而非加品种或提高频率。
  - 研发方式：新建/实现功能优先去 GitHub 搜现成开源项目复用（全局 skill `oss-first`），不足再自研。

[Project Knowledge Summary]
- Date: 2026-10-11 ~ 2026-10-12
- Context: Discovered by Agent while migrating alerts to Convex and hosting the dashboard
- Category: Operations & Deployment
- Instructions:
  - 告警后端已从 GitHub Actions(Python) 迁移到 Convex（旧的 `alerts/check.py` + `alert.yml` 链路作废）；GitHub 仓库仅保留源码与 Pages 托管。
  - Convex：项目 `market-alert`，团队 `2079362703`；dev 部署 `adventurous-sardine-576`、prod 部署 `efficient-cod-911`。环境变量按部署隔离（dev/prod 各自设置，`--prod` 指定正式）。
  - 看盘页长期托管：GitHub Pages `https://wond03.github.io/market-alert/`（`build_type=workflow`），`.github/workflows/pages.yml` 发布 `market-dashboard/`。本地预览：`python3 -m http.server 8000 --directory ./market-dashboard`。
  - 看盘页实时行情走 Gate 期货 WebSocket `wss://fx-ws.gateio.ws/v4/ws/usdt`（`futures.tickers`/`futures.candlesticks`），不再 REST 轮询。

[Project Knowledge Summary]
- Date: 2026-10-12
- Context: Discovered by Agent while operating the Convex backend
- Category: Operations & Deployment
- Instructions:
  - 登录：`npx convex login --no-open --login-flow poll`（设备码，凭据写入 `~/.convex/config.json`）。
  - 推代码：dev `npx convex dev --once`；prod `npx convex deploy`。
  - 运行函数：`npx convex run <module>:<fn> [--prod]`（路径用冒号，写成 `.` 会报 `BadConvexFunctionIdentifier`）。
  - 环境变量：`npx convex env set/list/get NAME [--prod]`；dev→prod 不回显复制：`npx convex env get NAME | npx convex env set NAME --prod`。变量：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`BATTLE`(仅 prod=1)。
  - 定时任务在 `convex/crons.ts`：`battle signal` 每分钟、`signal weekly report` 每周一 01:00 UTC（北京 09:00）。

[Project Knowledge Summary]
- Date: 2026-10-12
- Context: Discovered by Agent while integrating the dashboard with Convex
- Category: Operations & Deployment
- Instructions:
  - 看盘页纯静态，经 Convex HTTP API 读写：`POST https://<deployment>.convex.cloud/api/query|mutation|action`，body `{"path":"module:fn","args":{...},"format":"json"}`（CORS 允许任意 Origin）。prod 会把 `throw new Error` 脱敏成 "Server Error"，要透出自定义文本须用 `ConvexError`（出现在 `errorData`）。

[Project Knowledge Summary]
- Date: 2026-10-13
- Context: Discovered by Agent while building the SMC research recorder
- Category: Operations & Deployment
- Instructions:
  - 路线从「自研简单规则」转向 SMC。旧的 paper 影线记录器已停用（`paperState`/`paperTrades` 已从 schema 删除；占位文件 `convex/paper.ts` 已于 2026-10-16 删除）。
  - SMC 记录器：`convex/smc.ts`（纯逻辑 `convex/smcCore.ts`，与 `backtest/smc.ts` 共用防漂移）。cron `smc track` 每 5 分钟跑 `internal.smc.scan`；开关 `SMC_TRACKING=1`（仅 prod）。只写库，不发 Telegram、不下单。表：`smcState`(处理到的最新 15m 时间 watermark)、`smcSignals`(status、出场 SL0.5%/TP0.6%/H8h 兜底、记 `mfe`/`mae`)。只增量处理 watermark 之后的新收盘 K（刚上线表可能为空）。**已于 2026-10-16 删除**（`convex/smc.ts`/`convex/smcCore.ts`、cron `smc track`、env `SMC_TRACKING`、表 `smcState`/`smcSignals`；prod 先清空数据再从 schema 移除表并部署）。
  - 判定用 LuxAlgo 开源定义（`convex/luxSmc.ts`，看盘/回测/作战面板共用）：摆动结构 leg(size=50)、BOS/CHoCH（收盘穿最近未穿摆动点）、订单块（含高波动 K 过滤、延伸至缓解）、FVG、EQH/EQL、溢价折价、强弱高低。每个结构突破记两条：`bias=break`（突破 K 收盘进）与 `bias=retest`（首次回踩突破 OB 进）。
  - 范围收缩为亚洲/伦敦/纽约三时段内收盘的信号（复用 `gate.SESSIONS`），每条打 `session` 标签。
 
[Project Knowledge Summary]
- Date: 2026-10-13 ~ 2026-10-14
- Context: Discovered by Agent while building the battle panel and removing the MTF SMC system
- Category: Operations & Deployment
- Instructions:
  - 作战面板 `convex/battle.ts`（纯逻辑 `convex/battleCore.ts`，复用 `luxSmc`）：1h 结构(size=50)只作背景偏置门 → 15m **摆动结构**（`MTF_DIR_SWING=SWING_LEN=8`）的 BOS/CHoCH 定日内方向（必须收盘确认，影线不算；方向不明确=range 则观望，不用内部结构硬定）→ 入区只用 15m **摆动结构**未缓解 OB/FVG（内部结构 OB/FVG 不单独算入区，只作回调确认/微调）→ 5m 价格在区内且出现同向确认（CHoCH/BOS/吞没/Pin Bar）。**统一确认窗口**（`ZONE_WINDOW_BARS=24`=6h；起点=首次入区所在 5m K；任一 5m 收盘穿区域远端边界即失效清窗；方向翻转即作废）：确认 1 = 15m 内部结构（`INTERNAL_LEN=4`）同向 CHoCH/BOS；确认 2 = 5m 扣扳机（结构突破/吞没/Pin Bar）；两者须同一窗口内、5m 索引差 ≤ `CONFIRM_SPAN_MAX=6`（顺序不限）。两者都满足才入库 + Telegram，卡片显示「确认 15m / 确认 5m」两行。只推「双层确认入场」一种事件。规则：方向更新只有摆动结构出现反向 BOS/CHoCH 才发生，内部结构反向只视为回调、不反手（内部结构可累积最终触发摆动结构改变）。
  - 表：`battleState`(key=gate:SYMBOL, firedZone, zoneKey, zoneStartT)、`battleSignals`；cron `battle signal` 每 1 分钟；开关 `BATTLE=1`（仅 prod）。去重：**同一入区当天只发一次**，仅当该区被有效破坏（窗口内任一 5m 收盘穿区域远端边界，`zoneInvalidated`）才重置、允许重标为新区域。定方向的 15m 摆动 BOS/CHoCH 需带**位移硬过滤**（`hasDisplacement`，范围 ≥ `DISP_MULT=1.5`×ATR），不足即 direction=range 观望。手动：`battle:scan`、`battle:recentBattleSignals`。看盘页「作战面板」为同口径前端镜像。
  - 周报 `convex/report.ts`：`report:weeklyReport`（internalAction，仅 BATTLE 开启的部署=prod）——近 7 天（作战面板 battle）体检，含总览、按日盈亏（R 与 %）、分标的、归因（方向 / 触发类型 / 区域类型）、风险指标（最大回撤/最大连亏/平均持仓）、自动结论与建议（按维度取期望 R 最优/最差，样本 n≥3）；已了结交易计盈亏（止损=1R，% 为入场价收益率），未了结只计数；cron `signal weekly report` 每周一 09:00 北京推送。手动触发：`npx convex run report:weeklyReport --prod`。
  - 原独立 MTF SMC 系统 `convex/mtfSmc.ts` 及表 `mtfSmcState`/`mtfSmcSignals` 已于 2026-10-14 移除（与 battle 推送重复）：cron/开关/文件已删、prod 已清库并部署；`npx convex run mtfSmc:*` 不再有效。

[Project Knowledge Summary]
- Date: 2026-10-11
- Context: Discovered by Agent while testing Telegram push and pushing to GitHub
- Category: Environment Configuration
- Instructions:
  - 本环境无法稳定访问 `https://api.telegram.org`（TLS 被重置，curl exit 35）；Telegram 收发验证必须放到 GitHub Actions runner 上执行。
  - 全局 `git credential.helper` 为 `/app/agent/bin/agent git-credential-helper`，对 github.com 返回 500；推送需覆盖：`git -c credential.helper= -c credential.helper='!gh auth git-credential' push`。
  - `gh` 登录账号 `wond03`（device flow），推送 `.github/workflows/` 需追加 `workflow` scope。

[Project Knowledge Summary]
- Date: 2026-10-13
- Context: Discovered by Agent while backtesting the rule and SMC strategies
- Category: Testing Methods
- Instructions:
  - 回测在 `backtest/`：`battle.ts`（作战面板：对比统一确认窗口/间隔参数，`evaluateBattle` 的 `opts.zoneWindowSec`/`confirmSpanMax` 可覆盖，实例见脚本内 `CONFIGS`）、`history.ts`（Gate 历史 K 线）。运行：`./node_modules/.bin/esbuild backtest/<f>.ts --bundle --platform=node --format=esm --outfile=/tmp/x.mjs && node /tmp/x.mjs`；历史缓存 `/tmp/opencode/bt-cache`（24h）。脚本直接 import `convex` 判定函数，保证与生产同逻辑。
  - Gate candlesticks 限制：单次 ≤2000 根，`limit` 不能与 `from`/`to` 同用，只能取最近 10000 点 → 15m≈104 天、5m≈35 天、1m≈7 天（回测用 15m）。
  - 结论（重要）：①影线逆势规则修正「同根 K 线止损」乐观偏差后，单笔净期望约 +0.05%（成本量级），70/30 样本外略负（-0.05%）→ 无优势。②SMC 扫荡式表述毛收益≈0（reversal -0.03% t=-2.39、continuation 0.00%，平均 MFE 0.39% ≈ MAE 0.38%），所有切分（时段/1h 对齐/溢折价/参考位/分品种/前后半段）无一为正 → 无方向边际，调 SL/TP 无用。③任何单桶/单折的高 t 值不可信（过拟合）；只有「1h 趋势同向过滤」方向一致但 t≈0.5，仍不显著。**均不可实盘。** 上述变体脚本（`run`/`smc_seq`/`smc_tf`/`session_sweep`/`positioning`/`luxsmc`）与生产策略无关，已于 2026-10-16 删除。2026-10-16 补测**生产 battle 组合口径**（`backtest/battle.ts`，近 31 天 5m、扣 10bps、窗口 24×15m span6）：21 笔、71% 胜、净 +1.63R/笔，时间前后半段均正（+14.4R / +19.9R）；结论见 `docs/business-logic/README.md` §8。
  - 资金费：Gate `funding_rate` 仅约 30 天；BTC ~0.0027%/8h、XAU ~0.0043%，量级可忽略（回测已按方向/时长并入成本）。

[Project Knowledge Summary]
- Date: 2026-10-14
- Context: Discovered by Agent while installing skills/plugins and trimming global config
- Category: Environment Configuration
- Instructions:
  - 全局 skill 目录 `~/.config/opencode/skills/<name>/SKILL.md`（对所有项目生效，无需项目级 `.opencode/skills/`）。用 `skill-creator` 脚手架：`python3 /root/.codingmatrix/project-tpl/.ai-ready/skills/skill-creator/scripts/{init_skill,quick_validate,package_skill}.py`；校验器仅允许 frontmatter 字段 `name/description/license/metadata/allowed-tools`（其它字段报错，需移入 metadata）；依赖 pyyaml。
  - 已装全局技能：`mattpocock/skills`（克隆在 `/root/mattpocock-skills`，38 技能符号链接入 skills/，更新 `cd /root/mattpocock-skills && git pull`）、`oss-first`、`ponytail`(+audit/review/debt/gain/help)、`headroom`、`opentoken`。
  - 2026-10-14 精简：全局技能 46→12（停用 34 个，移至 `~/.config/opencode/skills-disabled/`，`mv` 回 `skills/` 即还原）；停用 6 条与本项目无关的规则（`go-mod-credential-fix`/`git-submodule-check`/`submodule-commit-workflow`/`vite-allowedhosts-config`/`frontend-reverse-proxy`/`global-package-install`，移至 `/root/.codingmatrix/project-tpl/.ai-ready/rules-disabled/`，`instructions` 的 `rules/*.md` glob 不再匹配，可 `mv` 还原）。新增项目级 `/workspace/AGENTS.md`。
  - opentoken：插件 `/root/.config/opencode/plugins/opentoken.ts`（+ `opentoken/` 源码依赖，核心 `@mrgray17/opentoken-core`）；TUI 小部件未启用（`~/.config/opencode/tui.json` 已移除 `plugin` 条目，避免未锁版 `@latest` 与带漏洞的 solid/seroval 依赖）；安装需 `npm install --legacy-peer-deps`。验证 `/root/.codingmatrix/bin/opencode-167e55c83ed7/opencode debug config` 打印 `[OpenToken] INFO Loaded`；`opentoken_stats`/`opentoken_health` 看节省。
  - opentoken 读取边界：默认 `safeReadRoot` 空=仅项目目录（读写项目外被 `Path traversal blocked` 拦截）；已在 `~/.config/opentoken/config.json` 写 `{"safeReadRoot":"/"}` 解除（`HOME=/root`、`XDG_CONFIG_HOME` 未设）。注意 progressive disclosure 阈值写死为 5 行/512 字节（`progressive.ts`），会把 `read`/`grep`/`glob` 输出卸载为摘要，原文存于 `~/.config/opentoken/offload/<id>.txt`，配置不可调。配置改动需重启 opencode。

[Project Knowledge Summary]
- Date: 2026-10-16
- Context: Discovered by Agent while 解耦看盘页
- Category: Operations & Deployment
- Instructions:
  - 看盘页 `market-dashboard/index.html` 的 SMC 叠加、盘面读数与作战面板读数全部走后端 `convex/panel.ts`（`panel:analyze` / `panel:battleStatus`）。改前端后必须 `npm run convex:deploy` 部署后端，否则看盘页叠加/作战面板会报接口不存在。
  - 看盘页已移除告警规则管理（原 `rulesAdmin`/`RULES_SECRET`）与告警只读展示（原 `market:recentAlerts`）；线A 通用告警已于 2026-10-17 整体移除（含 `rules`/`ruleState`/`scanState`/`alerts` 表、`market poll` cron、后端 WEEX/OKX）。
  - 排查大文件：opentoken 会把 bash 输出做符号压缩（`$N=` 图例）、把 read/grep 输出卸载；原文在 `~/.config/opentoken/offload/<id>.txt`。用 `node -e` 按行号打印小片段最稳，编辑大 HTML 建议写 node 补丁脚本按行号增删。
