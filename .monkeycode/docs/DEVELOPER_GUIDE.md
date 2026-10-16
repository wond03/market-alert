# 开发者指南

## 前置要求

- Node.js（用于 Convex CLI、TypeScript、tsx）。
- Convex 账号并已登录（`npx convex login`）。
- 一台可用 `gh` 登录的 GitHub 账号（用于推送与 Pages）。

## 安装

```bash
npm install
```

## 本地开发

```bash
# 本地 Convex 后端（dev 部署）
npm run convex:dev

# 类型检查
npx tsc -p tsconfig.json --noEmit

# 重新生成 Convex 绑定
npx convex codegen
```

前端是零构建静态页，直接本地起静态服务器预览：

```bash
python3 -m http.server 8000 --directory ./market-dashboard
```

## 部署

```bash
# 部署后端到生产 Convex
npm run convex:deploy
```

- 生产环境：`https://efficient-cod-911.convex.cloud`。
- 前端发布走 `.github/workflows/pages.yml`，推送 `master` 后自动发布 `market-dashboard/` 到 GitHub Pages。

## 回测

```bash
npx tsx backtest/battle.ts
```

脚本复用生产的 `evaluateBattle` + `battleCore` 纯逻辑，离线重放 Gate 历史，输出分组的 `n`、胜率、净 R、期望值等。详见 `模块/回测.md`。

## 提交与协作约定

（见仓库根 `AGENTS.md`）

- 回复使用用户语言，不使用 emoji。
- 除用户明确要求外，不添加代码注释。
- 未经明确批准不提交；提交前检查 `git status` / `git diff`，仅暂存目标文件。
- **不得改动止损 / 止盈 / RR 逻辑（`buildRisk`）**；Telegram 仅通知。
- 不删除数据或表；删除 Convex 表前先清空数据再 `convex deploy`。
- Secret 存 `.env.local`（已 gitignore），不得打印或提交。

## 已知环境问题

- 全局 `git credential.helper`（`/app/agent/bin/agent git-credential-helper`）对 GitHub 可能返回 `500`。此时用 `gh` 覆盖凭据后推送：

```bash
# 使用 gh 凭据覆盖失效的 helper
git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin master
```

- `gh` 推送 `.github/workflows/` 时令牌需含 `workflow` scope。

## 相关文档

- 业务总览：`docs/business-logic/README.md`
- 架构：`ARCHITECTURE.md`
- 接口：`INTERFACES.md`
- 项目记忆：`.monkeycode/MEMORY.md`
