import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({

 // 作战面板：每个 (交易所:标的) 的布防状态（记录已推送过的区域，离开后重进再推）
  battleState: defineTable({
    key: v.string(),
    firedZone: v.string(), // 最近已推送的区域指纹；空串表示可重新布防
    zoneKey: v.optional(v.string()), // 统一确认窗口：当前跟踪的区域指纹；空串/缺省 = 无活动窗口
    zoneStartT: v.optional(v.union(v.number(), v.null())), // 窗口起点：首次入区所在的 5m K 开盘时间
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
});
