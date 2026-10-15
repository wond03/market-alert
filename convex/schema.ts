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

  // 作战面板：每个 (交易所:标的) 的布防状态（记录已推送过的区域，离开后重进再推）
  battleState: defineTable({
    key: v.string(),
    firedZone: v.string(), // 最近已推送的区域指纹；空串表示可重新布防
    openDir: v.optional(v.union(v.string(), v.null())), // 未了结信号方向：long | short
    openEntry: v.optional(v.union(v.number(), v.null())), // 未了结信号入场价
    openStop: v.optional(v.union(v.number(), v.null())),
    openTarget: v.optional(v.union(v.number(), v.null())),
    openTs: v.optional(v.union(v.number(), v.null())), // 未了结信号触发时间
    openSignalId: v.optional(v.union(v.id("battleSignals"), v.null())), // 未了结信号对应的信号记录 _id
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // 作战面板：低周期确认入场的信号（记录 + 推送）
  battleSignals: defineTable({
    exchange: v.string(),
    symbol: v.string(),
    bias: v.string(), // long | short
    bg: v.optional(v.string()), // 1h 背景：bull | bear | range
    htfTag: v.string(), // 方向(15m)突破类型：BOS | CHoCH
    htfLevel: v.number(),
    zoneKind: v.string(), // OB | FVG
    zoneTop: v.number(),
    zoneBottom: v.number(),
    confirm: v.string(), // 低周期确认：CHoCH/BOS 向上/向下 | 吞没 | Pin Bar
    confirmInternal: v.optional(v.string()), // 15m 内部结构确认（回调结束）：CHoCH | BOS
    entryPrice: v.number(),
    stopPrice: v.number(),
    targetPrice: v.union(v.number(), v.null()),
    rr: v.union(v.number(), v.null()),
    sweep: v.optional(v.boolean()), // 是否在 HTF 上先出现流动性扫荡（更高质量）
    sweepLevel: v.optional(v.union(v.number(), v.null())),
    sigTs: v.number(), // 确认所在 5m K 线时间
    text: v.string(),
    createdAt: v.number(),
    // 了结结果（扫/到止损止盈后回填）
    result: v.optional(v.union(v.string(), v.null())), // stop | target
    exitPrice: v.optional(v.union(v.number(), v.null())), // 了结价
    closedTs: v.optional(v.union(v.number(), v.null())), // 了结时间
  }).index("by_sigTs", ["sigTs"]),

  // 作战面板：信号了结记录（扫止损 / 到止盈 / 离场取消），用于复盘每笔的止盈止损结果
  battleOutcomes: defineTable({
    exchange: v.string(),
    symbol: v.string(),
    bias: v.string(), // long | short
    entryPrice: v.number(),
    stopPrice: v.number(),
    targetPrice: v.union(v.number(), v.null()),
    rr: v.union(v.number(), v.null()),
    openedTs: v.number(), // 信号触发时间
    closedTs: v.number(), // 了结时间
    result: v.string(), // stop | target | cancel
    exitPrice: v.number(), // 了结价（扫止损/到止盈用该价位；取消用当时收盘）
    createdAt: v.number(),
  }).index("by_closedTs", ["closedTs"]),

  // SMC 记录器：LuxAlgo 结构突破（BOS/CHoCH）候选信号与假设成交（只记录，不推送/不交易）
  smcSignals: defineTable({    exchange: v.string(),
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
