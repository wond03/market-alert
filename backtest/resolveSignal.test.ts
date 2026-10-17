import assert from "node:assert";
import { resolveSignal } from "../convex/battleCore";

const bar = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c, v: 0 });

// A：信号根影线已触及目标，但入场发生在收盘后，入场后未再触及。
const a = [
  bar(0, 100, 101.5, 99.5, 100),
  bar(300, 100, 100.2, 99.8, 100),
];
assert.equal(resolveSignal(a, 0, "long", 99, 101), null);
// 同一组数据把起点前移一根，可复现旧行为（信号根参与判断）。
assert.equal(resolveSignal(a, -300, "long", 99, 101)?.result, "target");

// B：收盘未穿止损，影线穿过；旧逻辑（按收盘）不会止损。
const b = [
  bar(0, 100, 100.1, 99.9, 100),
  bar(300, 100, 100.2, 98.5, 99.4),
];
const r = resolveSignal(b, 0, "long", 99, 110);
assert.equal(r?.result, "stop");
assert.equal(r?.ts, 300);
assert.ok(99.4 > 99, "收盘价未破止损");

console.log("resolveSignal ok");
