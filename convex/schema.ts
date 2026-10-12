import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // 告警规则（相当于 alerts/config.json 的 rules）
  rules: defineTable({
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
  }),

  // 每条规则的当前上/下状态（相当于 state.json 的 rules）
  ruleState: defineTable({
    ruleKey: v.string(),
    side: v.union(v.literal("above"), v.literal("below")),
    level: v.number(),
  }).index("by_ruleKey", ["ruleKey"]),

  // 每个合约已处理到的最新 1 分钟 K 线时间（相当于 state.json 的 checked）
  scanState: defineTable({
    symbol: v.string(),
    checked: v.number(),
  }).index("by_symbol", ["symbol"]),

  // 已触发的告警记录（看盘页可订阅展示）
  alerts: defineTable({
    ts: v.number(),
    firedTs: v.number(),
    symbol: v.string(),
    label: v.string(),
    direction: v.string(),
    level: v.number(),
    price: v.number(),
    text: v.string(),
  }).index("by_ts", ["ts"]),
});
