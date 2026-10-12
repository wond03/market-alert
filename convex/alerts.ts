import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import * as gate from "./gate";
import * as exchanges from "./exchanges";
import type { Exchange } from "./exchanges";

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const value = proc?.env?.[name];
  return value ? String(value).trim() : "";
}

async function sendTelegram(text: string): Promise<void> {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; skipping push");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error(`telegram http error ${res.status}: ${await res.text()}`);
  }
}

// 推送链路自检：`npx convex run alerts:sendTest`
export const sendTest = internalAction({
  args: {},
  handler: async () => {
    await sendTelegram(
      "\u{1F4C8} <b>行情警报（测试）</b>\n\n" +
        "收到这条说明 Convex → Telegram 推送已打通。\n\n" +
        `<a href="${gate.DASHBOARD_URL}">\u{1F4C8} 打开看盘页</a>`,
    );
  },
});

// 每分钟运行：抓取新增的 1 分钟 K 线，判断穿越并推送。
export const pollAndCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const rawRules = await ctx.runQuery(internal.market.enabledRules, {});
    const rules: gate.RuleDoc[] = rawRules.map((r) => ({
      ...r,
      exchange: (r.exchange ?? "gate") as Exchange,
    }));
    if (rules.length === 0) {
      console.log("no rules configured; nothing to do");
      return;
    }

    const ruleStates = await ctx.runQuery(internal.market.allRuleStates, {});
    const scanStates = await ctx.runQuery(internal.market.allScanStates, {});
    const stateByKey = new Map(ruleStates.map((s) => [s.ruleKey, s]));
    const scanBySymbol = new Map(scanStates.map((s) => [s.symbol, s.checked]));

    // 按 (交易所, 标的) 分组，各自抓取对应交易所的 1 分钟 K 线
    const groups = new Map<
      string,
      { exchange: Exchange; symbol: string; rules: gate.RuleDoc[] }
    >();
    for (const r of rules) {
      const key = `${r.exchange}:${r.symbol}`;
      const g = groups.get(key);
      if (g) g.rules.push(r);
      else groups.set(key, { exchange: r.exchange, symbol: r.symbol, rules: [r] });
    }

    const baseCache = new Map<string, gate.Candle[]>();
    const now = Math.floor(Date.now() / 1000);

    for (const g of groups.values()) {
      const crossRules = g.rules.filter((r) => r.type !== "breakout");
      const breakRules = g.rules.filter((r) => r.type === "breakout");

      // ---- 固定价位穿越规则：1 分钟 K 线，收盘穿越即触发 ----
      if (crossRules.length > 0) {
        const stateKey = `${g.exchange}:${g.symbol}:${gate.SCAN_INTERVAL}`;
        const prevChecked = scanBySymbol.get(stateKey);

        let rows: gate.Candle[] = [];
        let newest: number | undefined;
        try {
          const data = await exchanges.getCandles(
            g.exchange,
            exchanges.contractOf(g.exchange, g.symbol),
            gate.SCAN_INTERVAL,
          );
          for (const cd of data) {
            if (prevChecked !== undefined && cd.t <= prevChecked) continue;
            rows.push(cd);
            if (newest === undefined || cd.t > newest) newest = cd.t;
          }
        } catch (e) {
          console.error(`fetch ${stateKey} failed: ${e}`);
          rows = [];
        }

        if (newest !== undefined && (prevChecked === undefined || newest > prevChecked)) {
          await ctx.runMutation(internal.market.upsertScanState, {
            symbol: stateKey,
            checked: newest,
          });
        }

        for (const rule of crossRules) {
          const rid = gate.ruleId(rule);
          let level: number;
          let isUp: boolean;
          let desc: string | undefined;
          try {
            const resolved = await gate.resolveLevel(rule, baseCache);
            level = resolved.level;
            isUp = resolved.isUp;
            desc = resolved.desc;
          } catch (e) {
            console.error(`resolve ${rid} failed: ${e}`);
            continue;
          }

          const prev = stateByKey.get(rid);
          const prevSide = prev?.side;
          const sameLevel =
            prev !== undefined && Math.abs(prev.level - level) < 1e-9;

          let side: gate.Side | undefined;
          let firedTs: number | null = null;
          let firedPrice: number | null = null;

          if (prevChecked !== undefined && prevSide !== undefined && sameLevel) {
            const res = gate.scanCross(rows, level, prevSide, isUp);
            firedTs = res.firedTs;
            firedPrice = res.firedPrice;
            side = res.side;
          } else {
            side = prevSide;
            for (let i = rows.length - 1; i >= 0; i--) {
              side = rows[i].c >= level ? "above" : "below";
              break;
            }
          }

          if (side !== undefined && (prevSide !== side || !sameLevel)) {
            await ctx.runMutation(internal.market.upsertRuleState, {
              ruleKey: rid,
              side,
              level,
            });
          }

          console.log(
            `${rule.label} ${g.exchange} ${g.symbol} level=${level} side=${side} ` +
              `prev=${prevSide} fired=${firedTs !== null ? "yes" : "no"}`,
          );

          if (firedTs !== null && firedPrice !== null) {
            const direction = isUp ? "上破" : "下破";
            const text = gate.buildMessage(rule, level, isUp, firedTs, firedPrice, desc);
            await ctx.runMutation(internal.market.insertAlerts, {
              alerts: [
                {
                  ts: now,
                  firedTs,
                  exchange: g.exchange,
                  symbol: g.symbol,
                  label: rule.label,
                  direction,
                  level,
                  price: firedPrice,
                  text,
                },
              ],
            });
            await sendTelegram(text);
          }
        }
      }

      // ---- 突破类规则：15 分钟 K 线，区分影线/实体 ----
      if (breakRules.length > 0) {
        const stateKey = `${g.exchange}:${g.symbol}:${gate.BREAK_INTERVAL}`;
        const prevChecked = scanBySymbol.get(stateKey);

        let rows: gate.Candle[] = [];
        let newest: number | undefined;
        try {
          const data = await exchanges.getCandles(
            g.exchange,
            exchanges.contractOf(g.exchange, g.symbol),
            gate.BREAK_INTERVAL,
          );
          for (const cd of data) {
            if (cd.t + gate.BREAK_SECONDS > now) continue; // 只看已收盘的 15 分钟 K 线
            if (prevChecked !== undefined && cd.t <= prevChecked) continue;
            rows.push(cd);
            if (newest === undefined || cd.t > newest) newest = cd.t;
          }
        } catch (e) {
          console.error(`fetch ${stateKey} failed: ${e}`);
          rows = [];
        }

        if (rows.length > 0) {
          rows.sort((a, b) => a.t - b.t);
        }

        if (newest !== undefined && (prevChecked === undefined || newest > prevChecked)) {
          await ctx.runMutation(internal.market.upsertScanState, {
            symbol: stateKey,
            checked: newest,
          });
        }

        for (const rule of breakRules) {
          const rid = gate.ruleId(rule);
          let level: number;
          let isUp: boolean;
          let desc: string | undefined;
          try {
            const resolved = await gate.resolveLevel(rule, baseCache);
            level = resolved.level;
            isUp = resolved.isUp;
            desc = resolved.desc;
          } catch (e) {
            console.error(`resolve ${rid} failed: ${e}`);
            continue;
          }

          const prev = stateByKey.get(rid);
          const prevSide = prev?.side;
          const prevWick = prev?.wickDone;
          const sameLevel =
            prev !== undefined && Math.abs(prev.level - level) < 1e-9;

          // 首次布防（尚无 15m 扫描位点）或关键位滚动：只按最新收盘布防，不回扫历史。
          const rearm = !sameLevel || prevChecked === undefined;
          let res: { events: gate.BreakEvent[]; side: gate.Side; wickDone: boolean };
          if (rearm) {
            const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
            const side: gate.Side = last
              ? (last.c >= level ? "above" : "below")
              : (prevSide ?? "below");
            res = { events: [], side, wickDone: false };
          } else {
            res = gate.scanBreakout(rows, level, isUp, prevSide, prevWick);
          }

          const changed =
            res.side !== prevSide ||
            !sameLevel ||
            res.wickDone !== (prevWick ?? false);
          if (changed && (rows.length > 0 || prev !== undefined)) {
            await ctx.runMutation(internal.market.upsertRuleState, {
              ruleKey: rid,
              side: res.side,
              level,
              wickDone: res.wickDone,
            });
          }

          console.log(
            `${rule.label} ${g.exchange} ${g.symbol} desc=${desc} level=${level} ` +
              `side=${res.side} prev=${prevSide} events=${res.events.length}`,
          );

          for (const ev of res.events) {
            const direction = isUp ? "上破" : "下破";
            const text = gate.buildMessage(
              rule,
              level,
              isUp,
              ev.ts,
              ev.price,
              desc,
              ev.kind,
            );
            await ctx.runMutation(internal.market.insertAlerts, {
              alerts: [
                {
                  ts: now,
                  firedTs: ev.ts,
                  exchange: g.exchange,
                  symbol: g.symbol,
                  label: rule.label,
                  direction,
                  signal: ev.kind,
                  level,
                  price: ev.price,
                  text,
                },
              ],
            });
            await sendTelegram(text);
          }
        }
      }
    }
  },
});
