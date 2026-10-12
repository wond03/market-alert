import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

// ---- 供告警 action 内部使用 ----

export const enabledRules = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("rules").collect();
    return all.filter((r) => r.enabled);
  },
});

export const allRuleStates = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("ruleState").collect(),
});

export const allScanStates = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("scanState").collect(),
});

export const upsertRuleState = internalMutation({
  args: {
    ruleKey: v.string(),
    side: v.union(v.literal("above"), v.literal("below")),
    level: v.number(),
  },
  handler: async (ctx, { ruleKey, side, level }) => {
    const existing = await ctx.db
      .query("ruleState")
      .withIndex("by_ruleKey", (q) => q.eq("ruleKey", ruleKey))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { side, level });
    } else {
      await ctx.db.insert("ruleState", { ruleKey, side, level });
    }
  },
});

export const upsertScanState = internalMutation({
  args: { symbol: v.string(), checked: v.number() },
  handler: async (ctx, { symbol, checked }) => {
    const existing = await ctx.db
      .query("scanState")
      .withIndex("by_symbol", (q) => q.eq("symbol", symbol))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { checked });
    } else {
      await ctx.db.insert("scanState", { symbol, checked });
    }
  },
});

export const insertAlerts = internalMutation({
  args: {
    alerts: v.array(
      v.object({
        ts: v.number(),
        firedTs: v.number(),
        exchange: v.optional(v.string()),
        symbol: v.string(),
        label: v.string(),
        direction: v.string(),
        level: v.number(),
        price: v.number(),
        text: v.string(),
      }),
    ),
  },
  handler: async (ctx, { alerts }) => {
    for (const a of alerts) {
      await ctx.db.insert("alerts", a);
    }
  },
});

// 批量替换规则（用 `npx convex run market:replaceRules '{...}'` 或控制台调用）
export const replaceRules = internalMutation({
  args: {
    rules: v.array(
      v.object({
        exchange: v.optional(
          v.union(v.literal("gate"), v.literal("weex"), v.literal("okx")),
        ),
        symbol: v.string(),
        label: v.string(),
        type: v.union(
          v.literal("cross_up"),
          v.literal("cross_down"),
          v.literal("breakout"),
        ),
        price: v.optional(v.number()),
        indicator: v.optional(v.string()),
        tf: v.optional(v.string()),
        offset: v.optional(v.number()),
        field: v.optional(v.string()),
        dir: v.optional(v.string()),
        enabled: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, { rules }) => {
    for (const r of rules) {
      await ctx.db.insert("rules", { ...r, enabled: r.enabled ?? true });
    }
  },
});

export const clearRules = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("rules").collect();
    for (const r of all) await ctx.db.delete(r._id);
  },
});

// ---- 供看盘页订阅的公开查询 ----

export const recentAlerts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("alerts")
      .withIndex("by_ts")
      .order("desc")
      .take(limit ?? 30);
  },
});

export const rules = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("rules").collect();
  },
});
