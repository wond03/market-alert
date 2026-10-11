const zlib = require("zlib");
const fs = require("fs");
const W = 512, H = 512;

function build(o, out) {
  const px = new Uint8Array(W * H * 4);
  const blend = (x, y, r, g, b, a) => {
    if (a <= 0) return;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4, inv = 1 - a;
    px[i] = Math.round(r * a + px[i] * inv);
    px[i + 1] = Math.round(g * a + px[i + 1] * inv);
    px[i + 2] = Math.round(b * a + px[i + 2] * inv);
    px[i + 3] = 255;
  };
  const rect = (x0, y0, x1, y1, r, g, b, a) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) blend(x, y, r, g, b, a);
  };
  const roundRect = (x0, y0, x1, y1, rad, r, g, b, a) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        let dx = 0, dy = 0;
        if (x < x0 + rad) dx = x0 + rad - x; else if (x > x1 - rad) dx = x - (x1 - rad);
        if (y < y0 + rad) dy = y0 + rad - y; else if (y > y1 - rad) dy = y - (y1 - rad);
        if (dx * dx + dy * dy <= rad * rad) blend(x, y, r, g, b, a);
      }
  };
  const disc = (cx, cy, r, col, a) => {
    for (let y = Math.round(cy - r); y <= cy + r; y++)
      for (let x = Math.round(cx - r); x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r) blend(x, y, col[0], col[1], col[2], a);
      }
  };
  const dot = (x, y, size, col, a) => {
    const h = size / 2;
    for (let yy = Math.round(y - h); yy < Math.round(y + h); yy++)
      for (let xx = Math.round(x - h); xx < Math.round(x + h); xx++) blend(xx, yy, col[0], col[1], col[2], a);
  };
  const line = (ax, ay, bx, by, size, col, a) => {
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      dot(ax + (bx - ax) * t, ay + (by - ay) * t, size, col, a);
    }
  };

  // background gradient
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = Math.round(o.bg[0][0] + (o.bg[1][0] - o.bg[0][0]) * t);
    const g = Math.round(o.bg[0][1] + (o.bg[1][1] - o.bg[0][1]) * t);
    const b = Math.round(o.bg[0][2] + (o.bg[1][2] - o.bg[0][2]) * t);
    for (let x = 0; x < W; x++) blend(x, y, r, g, b, 1);
  }
  // highlight
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - 150, y - 120) / 420;
      const a = Math.max(0, o.hlA * (1 - d));
      blend(x, y, o.hl[0], o.hl[1], o.hl[2], a);
    }
  // grid
  if (o.grid) {
    for (let i = 0; i <= 8; i++) {
      const gx = Math.round((i / 8) * W), gy = Math.round((i / 8) * H);
      rect(gx, 0, gx + 2, H, ...o.gridCol, o.gridA);
      rect(0, gy, W, gy + 2, ...o.gridCol, o.gridA);
    }
  }
  // candlesticks
  const C = [
    [118, 330, 392, 312, 410, true],
    [186, 300, 350, 284, 372, false],
    [254, 296, 344, 278, 366, true],
    [322, 246, 300, 228, 320, true],
    [390, 200, 258, 182, 276, true],
  ];
  const shift = o.candleShift || [0, 0];
  for (const [cx0, bt0, bb0, wt0, wb0, up] of C) {
    const cx = cx0 + shift[0], bt = bt0 + shift[1], bb = bb0 + shift[1],
      wt = wt0 + shift[1], wb = wb0 + shift[1];
    const col = up ? o.up : o.down;
    rect(cx - 5, wt, cx + 5, wb, col[0], col[1], col[2], 1);
    roundRect(cx - 20, bt, cx + 20, bb, 9, col[0], col[1], col[2], 1);
  }
  // arrow
  if (o.arrow) {
    const A = [96, 410], B = [418, 150];
    const ac = o.arrow.col;
    for (let s = 0; s <= 260; s++) {
      const t = s / 260;
      dot(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, 34, ac, 0.06);
    }
    for (let s = 0; s <= 260; s++) {
      const t = s / 260;
      dot(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, 15, ac, 0.97);
    }
    for (let s = 0; s <= 60; s++) {
      const t = s / 60;
      dot(B[0] - 60 * t, B[1] + 8 * t, 14, ac, 0.97);
      dot(B[0] - 34 * t, B[1] + 34 * t, 14, ac, 0.97);
    }
    rect(B[0] - 22, B[1] - 6, B[0] + 22, B[1] + 20, ac[0], ac[1], ac[2], 0.97);
  }
  // gold coin
  if (o.coin) {
    const cx = o.coin[0], cy = o.coin[1], r = o.coin[2];
    disc(cx, cy, r, [120, 82, 10], 1);            // rim shadow
    disc(cx, cy, r - 6, [255, 214, 90], 1);       // body
    disc(cx, cy, r - 6, [255, 236, 170], 0.35);   // sheen
    disc(cx - r * 0.3, cy - r * 0.3, r * 0.42, [255, 250, 225], 0.55);
    disc(cx, cy, r - 20, [230, 176, 40], 0.55);   // inner ring
    disc(cx, cy, r - 26, [255, 224, 120], 1);
    // stylized up-tick inside coin
    line(cx - r * 0.34, cy + r * 0.18, cx - r * 0.06, cy - r * 0.12, 9, [150, 96, 12], 0.9);
    line(cx - r * 0.06, cy - r * 0.12, cx + r * 0.34, cy - r * 0.42, 9, [150, 96, 12], 0.9);
    line(cx + r * 0.20, cy - r * 0.42, cx + r * 0.38, cy - r * 0.46, 9, [150, 96, 12], 0.9);
  }

  // encode
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, off = y * (W * 4 + 1) + 1 + x * 4;
      raw[off] = px[i]; raw[off + 1] = px[i + 1]; raw[off + 2] = px[i + 2]; raw[off + 3] = 255;
    }
  }
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  fs.writeFileSync(out, png);
  console.log("wrote", out, png.length, "bytes");
}

const GREEN = [38, 208, 124], RED = [246, 70, 93];

// v1: only candlesticks, no arrow
build({
  bg: [[11, 27, 58], [10, 58, 64]], hl: [90, 160, 255], hlA: 0.18, grid: true, gridCol: [255, 255, 255], gridA: 0.05,
  up: GREEN, down: RED, arrow: null, coin: null, candleShift: [0, 6],
}, "/workspace/market-dashboard/avatar-v1-candles.png");

// v2: candlesticks + arrow + gold coin
build({
  bg: [[16, 22, 44], [34, 26, 20]], hl: [255, 200, 120], hlA: 0.16, grid: true, gridCol: [255, 235, 190], gridA: 0.05,
  up: GREEN, down: RED, arrow: { col: [150, 225, 255] }, coin: [430, 96, 60], candleShift: [0, 10],
}, "/workspace/market-dashboard/avatar-v2-gold.png");

// v3: light color scheme
build({
  bg: [[244, 247, 251], [224, 236, 247]], hl: [255, 255, 255], hlA: 0.5, grid: true, gridCol: [30, 60, 110], gridA: 0.06,
  up: [16, 163, 127], down: [230, 60, 80], arrow: { col: [40, 120, 220] }, coin: null, candleShift: [0, 6],
}, "/workspace/market-dashboard/avatar-v3-light.png");

// v4: gold coin only + candlesticks, warm gold palette, no arrow
build({
  bg: [[26, 22, 16], [46, 36, 18]], hl: [255, 200, 110], hlA: 0.22, grid: true, gridCol: [255, 235, 190], gridA: 0.05,
  up: [60, 210, 140], down: [240, 90, 90], arrow: null, coin: [256, 168, 78], candleShift: [0, 40],
}, "/workspace/market-dashboard/avatar-v4-goldcoin.png");
