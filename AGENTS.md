# AGENTS.md

## Project

market-alert — Gate.io futures market dashboard with SMC/lux analysis + Telegram alerts.

## Layout

- `convex/` — Convex backend (TypeScript): schema, crons, alerts, market data, analysis cores.
- `market-dashboard/` — static dashboard (plain `index.html` + assets), served via GitHub Pages.
- `backtest/` — backtest scripts (Playwright / TypeScript).
- `.monkeycode/MEMORY.md` — persistent project knowledge (read before first reply).

## Build & Run

```bash
# install dependencies
npm install

# local Convex dev backend
npm run convex:dev

# deploy backend to production Convex
npm run convex:deploy
```

Frontend is static; no build step. Dashboard publish runs through `.github/workflows/pages.yml`.

## Conventions

- Reply in the user's language; no emoji; do not add code comments unless asked.
- Never alter stop-loss / take-profit / RR logic (`buildRisk`); Telegram is notification-only.
- Commit only after explicit user approval.
- Use background terminals for long-running commands; check existing terminals before starting builds.
- Do not delete data/tables; clear data before dropping a Convex table, then `convex deploy`.
- Secrets live in `.env.local` (git-ignored); never print or commit secret values.
