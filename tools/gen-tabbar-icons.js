/**
 * TabBar 图标生成器（纯 Node，无依赖）
 * 用法: node tools/gen-tabbar-icons.js
 * 产物: miniprogram/assets/tabbar/*.png (81x81, RGBA)
 *      + 放大约 4 倍的预览拼图（输出到系统临时目录，便于人眼校验）
 *
 * 图标风格：实心剪影 + 统一圆角，未选中灰、选中唐唐橙
 */
const fs = require('fs');
const os = require('os');
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
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 形状（点在形内测试） ----------
function inCircle(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRect(px, py, x1, y1, x2, y2) {
  return px >= x1 && px <= x2 && py >= y1 && py <= y2;
}

function inRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.max(Math.abs(px - cx) - hw + r, 0);
  const qy = Math.max(Math.abs(py - cy) - hh + r, 0);
  return Math.abs(px - cx) <= hw && Math.abs(py - cy) <= hh && qx * qx + qy * qy <= r * r;
}

function inCapsule(px, py, x1, y1, x2, y2, r) {
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
const C = 40.5; // 画布中心

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

const icons = {
  // 首页：房子（屋顶 + 墙体，留出门洞）
  home(px, py) {
    const roof = inTriangle(px, py, C, 8, 7, 41, 74, 41);
    const body = inRect(px, py, 16, 39, 65, 72);
    const door = inRoundRect(px, py, C, 72, 9, 20, 5) && py >= 52;
    return (roof || body) && !door;
  },
  // 跑步：跑动的人形剪影（头 + 前倾躯干 + 摆臂 + 前后腿）
  run(px, py) {
    const head = inCircle(px, py, 51, 14, 8.2);
    const torso = inCapsule(px, py, 46, 26, 36, 46, 6.2);
    const arm = inCapsule(px, py, 47, 30, 63, 33, 4.4);
    const armDown = inCapsule(px, py, 47, 32, 33, 44, 4.2);
    const thighFront = inCapsule(px, py, 36, 45, 52, 56, 5.6);
    const shinFront = inCapsule(px, py, 52, 56, 58, 70, 5.2);
    const legBack = inCapsule(px, py, 36, 45, 15, 61, 5.6);
    return head || torso || arm || armDown || thighFront || shinFront || legBack;
  },
  // 记录：卡片 + 三条文本行（挖空）
  records(px, py) {
    const card = inRoundRect(px, py, C, 42, 26, 31, 9);
    const line1 = inRoundRect(px, py, 36, 28, 15, 3.2, 3);
    const line2 = inRoundRect(px, py, 36, 42, 15, 3.2, 3);
    const line3 = inRoundRect(px, py, 30, 56, 21, 3.2, 3);
    return card && !line1 && !line2 && !line3;
  },
  // 排行：三根高低柱
  ranking(px, py) {
    const bar1 = inRoundRect(px, py, 19, 58, 9.5, 12, 5);
    const bar2 = inRoundRect(px, py, 40.5, 44, 9.5, 26, 5);
    const bar3 = inRoundRect(px, py, 62, 52, 9.5, 18, 5);
    return bar1 || bar2 || bar3;
  },
  // 我的：人像剪影
  profile(px, py) {
    const head = inCircle(px, py, C, 26, 13.5);
    const shoulder = inRoundRect(px, py, C, 66, 25, 22, 22) && py <= 66;
    return head || shoulder;
  },
};

// 未选中灰 / 选中唐唐橙
const PALETTE = {
  '': [154, 160, 166],
  '-active': [255, 107, 0],
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

// ---------- 预览拼图（4 倍放大，白底，仅用于人眼校验，不进入小程序包） ----------
const SCALE = 4;
const PAD = 18;
const names = Object.keys(icons);
const cellW = SIZE * SCALE;
const sheetW = names.length * cellW + (names.length + 1) * PAD;
const sheetH = 2 * cellW + 3 * PAD;
const sheet = Buffer.alloc(sheetW * sheetH * 4, 255); // 白底
for (let i = 0; i < sheetW * sheetH; i++) sheet[i * 4 + 3] = 255;

names.forEach((name, col) => {
  [['', 0], ['-active', 1]].forEach(([suffix, row]) => {
    const color = PALETTE[suffix];
    const rgba = render(icons[name], color);
    const ox = PAD + col * (cellW + PAD);
    const oy = PAD + row * (cellW + PAD);
    for (let y = 0; y < cellW; y++) {
      for (let x = 0; x < cellW; x++) {
        const sx = Math.floor(x / SCALE);
        const sy = Math.floor(y / SCALE);
        const si = (sy * SIZE + sx) * 4;
        const a = rgba[si + 3] / 255;
        const di = ((oy + y) * sheetW + ox + x) * 4;
        sheet[di] = Math.round(rgba[si] * a + 255 * (1 - a));
        sheet[di + 1] = Math.round(rgba[si + 1] * a + 255 * (1 - a));
        sheet[di + 2] = Math.round(rgba[si + 2] * a + 255 * (1 - a));
        sheet[di + 3] = 255;
      }
    }
  });
});
const previewFile = path.join(os.tmpdir(), 'tt-tabbar-preview.png');
fs.writeFileSync(previewFile, encodePNG(sheetW, sheetH, sheet));
console.log('预览拼图', previewFile, `顺序=${names.join(' / ')}（上排未选中，下排选中）`);
console.log('完成');
