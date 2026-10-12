/**
 * TabBar 图标生成器（纯 Node，无依赖）
 * 用法: node tools/gen-tabbar-icons.js
 * 产物: miniprogram/assets/tabbar/*.png (81x81, RGBA)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 形状（点在形内测试） ----------
function inCircle(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRing(px, py, cx, cy, rOuter, rInner) {
  return inCircle(px, py, cx, cy, rOuter) && !inCircle(px, py, cx, cy, rInner);
}

function inRect(px, py, x1, y1, x2, y2) {
  return px >= x1 && px <= x2 && py >= y1 && py <= y2;
}

function inRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.max(Math.abs(px - cx) - hw + r, 0);
  const qy = Math.max(Math.abs(py - cy) - hh + r, 0);
  return Math.abs(px - cx) <= hw && Math.abs(py - cy) <= hh && qx * qx + qy * qy <= r * r;
}

function inRoundRectRing(px, py, cx, cy, hw, hh, rOuter, thickness) {
  return (
    inRoundRect(px, py, cx, cy, hw, hh, rOuter) &&
    !inRoundRect(px, py, cx, cy, hw - thickness, hh - thickness, Math.max(1, rOuter - thickness))
  );
}

function inCapsule(px, py, x1, y1, x2, y2, r) {
  // 点到线段距离
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const ex = px - (x1 + t * dx);
  const ey = py - (y1 + t * dy);
  return ex * ex + ey * ey <= r * r;
}

function inTriangle(px, py, ax, ay, bx, by, cx2, cy2) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx2, cy2);
  const d3 = sign(px, py, cx2, cy2, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ---------- 图标定义（81x81 逻辑坐标，4x4 超采样） ----------
const SIZE = 81;
const SS = 4; // 每像素采样 4x4

function render(shapes, color) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const [r, g, b] = color;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (shapes(px, py)) hit++;
        }
      }
      const a = Math.round((hit / (SS * SS)) * 255);
      const i = (y * SIZE + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return rgba;
}

const C = 40.5; // 中心

const icons = {
  // 首页：房子
  home(px, py) {
    const roof = inTriangle(px, py, C, 10, 8, 40, 73, 40);
    const body = inRect(px, py, 17, 38, 64, 70);
    const door = inRect(px, py, 33, 50, 48, 70);
    return (roof || body) && !door;
  },
  // 日历：圆角框 + 两个挂环 + 三个点
  calendar(px, py) {
    const frame = inRoundRectRing(px, py, C, 45, 29, 24, 6, 5);
    const ring1 = inCapsule(px, py, 28, 12, 28, 26, 2.6);
    const ring2 = inCapsule(px, py, 53, 12, 53, 26, 2.6);
    const dot1 = inCircle(px, py, 28, 48, 3.6);
    const dot2 = inCircle(px, py, C, 48, 3.6);
    const dot3 = inCircle(px, py, 53, 48, 3.6);
    const dot4 = inCircle(px, py, 28, 59, 3.6);
    const dot5 = inCircle(px, py, C, 59, 3.6);
    return frame || ring1 || ring2 || dot1 || dot2 || dot3 || dot4 || dot5;
  },
  // 我的：人像
  profile(px, py) {
    const head = inCircle(px, py, C, 27, 13);
    const body = inCircle(px, py, C, 71, 24) && py <= 68;
    return head || body;
  },
};

const PALETTE = {
  '': [139, 139, 139], // 未选中 灰
  '-active': [0, 82, 217], // 选中 TDesign 蓝
};

const outDir = path.join(__dirname, '../miniprogram/assets/tabbar');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, fn] of Object.entries(icons)) {
  for (const [suffix, color] of Object.entries(PALETTE)) {
    const png = encodePNG(SIZE, SIZE, render(fn, color));
    const file = path.join(outDir, `${name}${suffix}.png`);
    fs.writeFileSync(file, png);
    console.log('生成', path.relative(process.cwd(), file), `${png.length}B`);
  }
}
console.log('完成');
