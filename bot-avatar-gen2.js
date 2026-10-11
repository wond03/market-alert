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
  const rect = (x0, y0, x1, y1, c, a) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) blend(x, y, c[0], c[1], c[2], a);
  };
  const roundRect = (x0, y0, x1, y1, rad, c, a) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        let dx = 0, dy = 0;
        if (x < x0 + rad) dx = x0 + rad - x; else if (x > x1 - rad) dx = x - (x1 - rad);
        if (y < y0 + rad) dy = y0 + rad - y; else if (y > y1 - rad) dy = y - (y1 - rad);
        if (dx * dx + dy * dy <= rad * rad) blend(x, y, c[0], c[1], c[2], a);
      }
  };
  const disc = (cx, cy, r, c, a) => {
    for (let y = Math.round(cy - r); y <= cy + r; y++)
      for (let x = Math.round(cx - r); x <= cx + r; x++)
        if (Math.hypot(x - cx, y - cy) <= r) blend(x, y, c[0], c[1], c[2], a);
  };
  const halfDiscRight = (cx, cy, r, c, a) => {
    for (let y = Math.round(cy - r); y <= cy + r; y++)
      for (let x = Math.round(cx); x <= cx + r; x++)
        if (Math.hypot(x - cx, y - cy) <= r) blend(x, y, c[0], c[1], c[2], a);
  };
  const dot = (x, y, size, c, a) => {
    const h = size / 2;
    for (let yy = Math.round(y - h); yy < Math.round(y + h); yy++)
      for (let xx = Math.round(x - h); xx < Math.round(x + h); xx++) blend(xx, yy, c[0], c[1], c[2], a);
  };
  const inPoly = (x, y, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const poly = (pts, c, a) => {
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const [x, y] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    for (let y = Math.round(miny); y <= maxy; y++)
      for (let x = Math.round(minx); x <= maxx; x++)
        if (inPoly(x + 0.5, y + 0.5, pts)) blend(x, y, c[0], c[1], c[2], a);
  };

  // bg
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const c = [0, 1, 2].map((k) => Math.round(o.bg[0][k] + (o.bg[1][k] - o.bg[0][k]) * t));
    for (let x = 0; x < W; x++) blend(x, y, c[0], c[1], c[2], 1);
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - 150, y - 120) / 420;
      blend(x, y, o.hl[0], o.hl[1], o.hl[2], Math.max(0, o.hlA * (1 - d)));
    }
  for (let i = 0; i <= 8; i++) {
    const g = Math.round((i / 8) * W);
    rect(g, 0, g + 2, H, o.gridCol, o.gridA);
    rect(0, g, W, g + 2, o.gridCol, o.gridA);
  }

  // candles
  const C = [
    [118, 330, 392, 312, 410, true],
    [186, 300, 350, 284, 372, false],
    [254, 296, 344, 278, 366, true],
    [322, 246, 300, 228, 320, true],
    [390, 200, 258, 182, 276, true],
  ];
  const sh = o.candleShift || [0, 0];
  for (const [cx0, bt0, bb0, wt0, wb0, up] of C) {
    const cx = cx0 + sh[0], d = sh[1];
    const col = up ? o.up : o.down;
    rect(cx - 5, wt0 + d, cx + 5, wb0 + d, col, 1);
    roundRect(cx - 20, bt0 + d, cx + 20, bb0 + d, 9, col, 1);
  }

  // gold ingot (3D)
  if (o.bar) {
    const [cx, cy, w, h] = o.bar;
    const inset = w * 0.17;
    const yBot = cy + h / 2, yTop = cy - h / 2;
    const BL = [cx - w / 2, yBot], BR = [cx + w / 2, yBot];
    const TL = [cx - (w / 2 - inset), yTop], TR = [cx + (w / 2 - inset), yTop];
    const D = [inset * 0.8, -h * 0.52];
    const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
    poly([BR, TR, add(TR, D), add(BR, D)], [168, 116, 16], 1);   // right face
    poly([TL, TR, add(TR, D), add(TL, D)], [255, 228, 138], 1);  // top face
    poly([BL, BR, TR, TL], [214, 158, 34], 1);                   // front face
    poly([add(TL, [0, 4]), add(TR, [0, 4]), add(TR, [0, 14]), add(TL, [0, 14])], [255, 244, 186], 0.45); // top edge sheen
    poly([[cx - w * 0.2, yBot - 8], [cx - w * 0.04, yBot - 8], [cx + w * 0.08, yTop + 8], [cx - w * 0.08, yTop + 8]], [255, 250, 214], 0.3); // shine
  }

  // coin with BTC
  if (o.coinBTC) {
    const [cx, cy, r] = o.coinBTC;
    disc(cx, cy, r, [120, 82, 10], 1);
    disc(cx, cy, r - 6, [255, 214, 90], 1);
    disc(cx - r * 0.3, cy - r * 0.3, r * 0.5, [255, 250, 225], 0.4);
    disc(cx, cy, r - 20, [230, 176, 40], 0.35);
    // BTC symbol
    const col = [120, 74, 8];
    const h = r * 0.95, w = h * 0.52, thick = h * 0.14, tick = h * 0.13;
    const x0 = cx - w / 2, y0 = cy - h / 2, y1 = cy + h / 2, midY = cy;
    const d = thick * 1.25, xL = x0 + d;
    rect(x0, y0 - tick, x0 + thick, y1 + tick, col, 1);
    rect(x0 + d - thick, y0 - tick, x0 + d, y1 + tick, col, 1);
    halfDiscRight(xL, (y0 + midY) / 2, (midY - y0) / 2, col, 1);
    halfDiscRight(xL, (midY + y1) / 2, (y1 - midY) / 2, col, 1);
  }

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
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
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

// v5: no arrow, candlesticks + gold bar, indigo/violet palette
build({
  bg: [[27, 17, 64], [58, 30, 99]], hl: [150, 120, 255], hlA: 0.18, gridCol: [220, 210, 255], gridA: 0.05,
  up: GREEN, down: RED, candleShift: [0, 66], bar: [256, 150, 190, 96],
}, "/workspace/market-dashboard/avatar-v5-bar-indigo.png");

// v6: no arrow, candlesticks + coin with BTC symbol, graphite + gold
build({
  bg: [[26, 24, 22], [52, 42, 22]], hl: [255, 200, 120], hlA: 0.16, gridCol: [255, 235, 190], gridA: 0.045,
  up: GREEN, down: RED, candleShift: [0, 62], coinBTC: [256, 158, 84],
}, "/workspace/market-dashboard/avatar-v6-btc-coin.png");

// v7: no arrow, candlesticks + gold bar, teal/emerald palette
build({
  bg: [[8, 34, 43], [12, 62, 52]], hl: [120, 235, 200], hlA: 0.2, gridCol: [200, 255, 235], gridA: 0.05,
  up: GREEN, down: RED, candleShift: [0, 66], bar: [256, 150, 190, 96],
}, "/workspace/market-dashboard/avatar-v7-bar-teal.png");
