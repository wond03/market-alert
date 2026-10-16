# SMC / lux 结构概念

`convex/luxSmc.ts` 是不依赖 Convex 的纯计算模块，把一套 SMC（Smart Money Concepts）结构识别从 Pine 脚本移植为 TypeScript，供作战面板、看盘页与回测复用。

## 常量

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `SWING_LEN` | 8 | 摆动级别结构长度 |
| `INTERNAL_LEN` | 4 | 内部级别结构长度 |
| `EQ_LEN` | 3 | 均衡线比较回看 |
| `EQ_THRESHOLD` | 0.1 | 等高等低判定（相对 ATR） |
| `ATR_LEN` | 200 | ATR 周期 |

## 核心概念

- **摆动点（Pivot）**：按 `size` 长度的分段极值确定高低点，用于勾勒结构。
- **结构突破 `BOS` / `CHoCH`**：收盘价穿越最近一个未被吃掉的摆动点；与原趋势同向为 `BOS`，反向为 `CHoCH`。
- **订单块 OB（Order Block）**：结构突破处的对手方 K 线区域；高波动时按解析高低点交换，波动用 `ATR(200)` 度量。
- **公允价值缺口 FVG（Fair Value Gap）**：三根 K 线间的价格缺口，被回补后标记为已缓解（mitigated）。
- **均衡线 EQH / EQL**：相邻摆动高点 / 低点价差小于 `EQ_THRESHOLD × ATR` 时视为等高等低，构成流动性池。
- **移动极值（Trailing Extremes）**：由摆动极值给出的 premium / discount 参考，含强 / 弱高低点。
- **位移（Displacement）**：区域附近出现范围 ≥ `DISP_MULT × ATR` 的同向 K 线，用以确认资金推动。
- **流动性扫荡（Sweep）**：在 `SWEEP_LOOKBACK` 内价格扫过对侧摆动流动性；出现扫荡的信号视为更高质量。

## 主要函数

| 函数 | 返回 | 说明 |
| --- | --- | --- |
| `atr(candles, period)` | `number[]` | Wilder RMA 平滑，等价 Pine `ta.atr` |
| `runStructure(candles, size, volMode)` | `StructureResult` | 摆动点、突破、订单块、末段趋势 |
| `computeFvgs(candles)` | `Fvg[]` | 缺口检测与缓解追踪 |
| `computeEqhEql(candles, size?, mult?)` | `EqLine[]` | 等高等低 |
| `computeTrailing(candles, size)` | `TrailingExtremes` | premium / discount 极值 |

## 在系统中的使用

- `battleCore.ts`：以 OB / FVG 作为入区来源，用位移、扫荡、均衡线做质量过滤。
- `panel.ts`：向前端返回 `runStructure` / `computeFvgs` / `computeTrailing` / `computeEqhEql` 的结果用于叠加绘制。
- `backtest/battle.ts`：通过 `evaluateBattle` 间接复用。
