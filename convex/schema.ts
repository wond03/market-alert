import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // 告警规则（相当于 alerts/config.json 的 rules）
  rules: defineTable({
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
    enabled: v.boolean(),
  }),

  // 每条规则的当前上/下状态（相当于 state.json 的 rules）
  ruleState: defineTable({
    ruleKey: v.string(),
    side: v.union(v.literal("above"), v.literal("below")),
    level: v.number(),
    // 本段触碰是否已推送过「影线突破」（突破类规则使用）
    wickDone: v.optional(v.boolean()),
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
    exchange: v.optional(v.string()),
    symbol: v.string(),
    label: v.string(),
    direction: v.string(),
    signal: v.optional(v.string()),
    level: v.number(),
    price: v.number(),
    text: v.string(),
  }).index("by_ts", ["ts"]),

  // SMC 记录器：每个 (交易所:标的) 已处理到的最新 15m K 线时间
  smcState: defineTable({
    key: v.string(),
    checked: v.number(),
  }).index("by_key", ["key"]),

  // MTF SMC：每个 (交易所:标的) 的多周期扫描状态
  mtfSmcState: defineTable({
    key: v.string(),
    last1hT: v.number(), // 已处理的 1h K 线时间
    last5mT: v.number(), // 已处理的 5m K 线时间
    last15mT: v.number(), // 已处理的 15m K 线时间
    armedDir: v.optional(v.string()), // 1h 武装方向：bull | bear
    armedTag: v.optional(v.string()), // 1h 突破类型：BOS | CHoCH
    armedLevel: v.optional(v.number()),
    armedTs: v.optional(v.number()),
    fired: v.boolean(), // 当前 1h 结构窗口是否已推送
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // MTF SMC：1h→5m/15m 同向确认的入场信号（记录 + 推送）
  mtfSmcSignals: defineTable({
    exchange: v.string(),
    symbol: v.string(),
    tf: v.string(), // 触发的小周期：5m | 15m
    armedDir: v.string(), // 1h 方向：bull | bear
    armedTag: v.string(), // 1h 突破类型：BOS | CHoCH
    armedLevel: v.number(),
    armedTs: v.number(),
    tag: v.string(), // 小周期突破类型：BOS | CHoCH
    level: v.number(),
    entryPrice: v.number(),
    sigTs: v.number(),
    bias: v.string(), // long | short
    text: v.string(),
    createdAt: v.number(),
  }).index("by_sigTs", ["sigTs"]),

  // SMC 记录器：LuxAlgo 结构突破（BOS/CHoCH）候选信号与假设成交（只记录，不推送/不交易）
  smcSignals: defineTable({
    exchange: v.string(),
    symbol: v.string(),
    sigTs: v.number(),
    session: v.string(), // 亚洲盘 | 伦敦盘 | 纽约盘（仅记录三大时段内的信号）
    level: v.number(), // 被突破的摆动点价位
    levelKind: v.string(), // structural
    tag: v.optional(v.string()), // BOS | CHoCH
    sweepSide: v.string(), // bull | bear（突破方向）
    bias: v.string(), // break | retest
    tradeDir: v.string(), // long | short
    entryPrice: v.number(),
    pen: v.number(), // 刺破幅度
    rangeHigh: v.optional(v.number()),
    rangeLow: v.optional(v.number()),
    posPct: v.optional(v.number()), // 在 dealing range 中的位置 0..1
    zone: v.string(), // premium | discount | mid
    trend1h: v.string(), // bull | bear | range
    trend15: v.string(),
    align1h: v.boolean(), // 该方向是否与 1h 结构同向
    align15: v.boolean(),
    fvgAbove: v.optional(v.number()), // 最近未填补 FVG 距现价（比例）
    fvgBelow: v.optional(v.number()),
    fvgAboveDir: v.optional(v.string()),
    fvgBelowDir: v.optional(v.string()),
    sl: v.number(),
    tp: v.number(),
    holdH: v.number(),
    status: v.string(), // open | closed
    exitTs: v.optional(v.number()),
    exitPrice: v.optional(v.number()),
    reason: v.optional(v.string()), // stop | target | timeout
    gross: v.optional(v.number()),
    net: v.optional(v.number()),
    mfe: v.optional(v.number()), // 最大有利波动
    mae: v.optional(v.number()), // 最大不利波动
    openedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_sigTs", ["sigTs"]),
});
