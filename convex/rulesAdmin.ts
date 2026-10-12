// 公开的规则管理接口（供看盘页「警报设置」面板调用）。
// 读操作走 market:rules / market:recentAlerts（公开 query）；
// 写操作需要口令，口令存 Convex 环境变量 RULES_SECRET。

import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { ruleId } from "./gate";
import type { Exchange } from "./exchanges";

function env(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  return (proc?.env?.[name] ?? "").trim();
}

function requireSecret(secret: string): void {
  const expected = env("RULES_SECRET");
  if (!expected) {
    throw new ConvexError("服务端未设置 RULES_SECRET，无法修改规则");
  }
  if ((secret ?? "").trim() !== expected) {
    throw new ConvexError("口令错误");
  }
}

type RuleShape = {
  exchange?: "gate" | "weex" | "okx";
  symbol: string;
  type: string;
  tf?: string;
  offset?: number;
  field?: string;
  dir?: string;
  indicator?: string;
  price?: number;
};

// 与告警轮询所用的 ruleKey 保持一致（gate.ruleId）
function keyOf(doc: RuleShape): string {
  return ruleId(
    { ...doc, exchange: (doc.exchange ?? "gate") as Exchange } as unknown as Parameters<
      typeof ruleId
    >[0],
  );
}

async function clearState(ctx: MutationCtx, ruleKey: string): Promise<void> {
  const rows = await ctx.db
    .query("ruleState")
    .withIndex("by_ruleKey", (q) => q.eq("ruleKey", ruleKey))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

const ruleValidator = v.object({
  exchange: v.union(v.literal("gate"), v.literal("weex"), v.literal("okx")),
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
  enabled: v.boolean(),
});

type RuleInput = {
  exchange: "gate" | "weex" | "okx";
  symbol: string;
  label: string;
  type: "cross_up" | "cross_down" | "breakout";
  price?: number;
  indicator?: string;
  tf?: string;
  offset?: number;
  field?: string;
  dir?: string;
  enabled: boolean;
};

// 只保留已定义的字段，避免把 undefined 写入文档
function clean(rule: RuleInput) {
  return {
    exchange: rule.exchange,
    symbol: rule.symbol,
    label: rule.label,
    type: rule.type,
    enabled: rule.enabled,
    ...(rule.price != null ? { price: rule.price } : {}),
    ...(rule.indicator != null ? { indicator: rule.indicator } : {}),
    ...(rule.tf != null ? { tf: rule.tf } : {}),
    ...(rule.offset != null ? { offset: rule.offset } : {}),
    ...(rule.field != null ? { field: rule.field } : {}),
    ...(rule.dir != null ? { dir: rule.dir } : {}),
  };
}

export const upsertRule = mutation({
  args: {
    secret: v.string(),
    id: v.optional(v.id("rules")),
    rule: ruleValidator,
  },
  handler: async (ctx, { secret, id, rule }) => {
    requireSecret(secret);
    const doc = clean(rule);
    if (id) {
      const existing = await ctx.db.get(id);
      if (existing) {
        const oldKey = keyOf(existing);
        await ctx.db.replace(id, doc);
        const newKey = keyOf(rule);
        if (oldKey !== newKey) await clearState(ctx, oldKey);
        return id;
      }
    }
    return await ctx.db.insert("rules", doc);
  },
});

export const deleteRule = mutation({
  args: { secret: v.string(), id: v.id("rules") },
  handler: async (ctx, { secret, id }) => {
    requireSecret(secret);
    const existing = await ctx.db.get(id);
    if (!existing) return;
    await clearState(ctx, keyOf(existing));
    await ctx.db.delete(id);
  },
});

export const setEnabled = mutation({
  args: { secret: v.string(), id: v.id("rules"), enabled: v.boolean() },
  handler: async (ctx, { secret, id, enabled }) => {
    requireSecret(secret);
    const existing = await ctx.db.get(id);
    if (!existing) return;
    await ctx.db.patch(id, { enabled });
    if (!enabled) await clearState(ctx, keyOf(existing));
  },
});
