import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 每分钟轮询 Gate.io，扫描新增 1 分钟 K 线并判断穿越。
crons.interval("market poll", { minutes: 1 }, internal.alerts.pollAndCheck, {});

// 每 5 分钟运行 SMC 记录器（仅记录流动性扫荡信号与假设成交，不推送/不交易）。
crons.interval("smc track", { minutes: 5 }, internal.smc.scan, {});

// 每分钟运行 MTF SMC：1h 结构 → 5m/15m 同向确认 → 入库 + 推送。
crons.interval("mtf smc", { minutes: 1 }, internal.mtfSmc.scan, {});

export default crons;
