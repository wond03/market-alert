import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 每分钟运行 SMC 入场信号：1h 背景 → 15m 方向 + OB/FVG 入区 → 5m 同向确认入场 → 入库 + 推送。
crons.interval("battle signal", { minutes: 1 }, internal.battle.scan, {});

// 每周一 01:00 UTC 审计推送失败率；命中阈值才推监控消息，暂停决策人工。
crons.weekly(
  "push failure audit",
  { dayOfWeek: "monday", hourUTC: 1, minuteUTC: 0 },
  internal.battle.auditPushFailures,
  {},
);

export default crons;
