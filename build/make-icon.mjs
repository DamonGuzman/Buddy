#!/usr/bin/env node
/**
 * Generates Windows, macOS app, and macOS menu-bar icons from Buddy —
 * the rounded blue gradient triangle with eyes — entirely programmatically:
 * an SDF rasterizer + a minimal zlib-based PNG encoder + an ICO container.
 * No dependencies beyond node:zlib. The geometry mirrors BuddySvg in
 * src/renderer/overlay/main.tsx (40x40 viewBox, stroke-width 7 round join =
 * a 3.5-unit rounding radius on the triangle).
 *
 * Usage: node build/make-icon.mjs
 * Writes icon.ico, icon.icns, trayTemplate.png, and trayTemplate@2x.png.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = path.dirname(fileURLToPath(import.meta.url));
const ICO_OUT = path.join(BUILD_DIR, 'icon.ico');
const ICNS_OUT = path.join(BUILD_DIR, 'icon.icns');
const TRAY_OUT = path.join(BUILD_DIR, 'trayTemplate.png');
const TRAY_2X_OUT = path.join(BUILD_DIR, 'trayTemplate@2x.png');

// ---------------------------------------------------------------------------
// Buddy geometry (viewBox 0 0 40 40 — see BuddySvg)
// ---------------------------------------------------------------------------
const TRI = [
  [20, 7],
  [34, 32.5],
  [6, 32.5],
];
const ROUND = 3.5; // stroke-width 7, round join → 3.5 outward rounding
const GRAD_TOP = [0x7c, 0xc4, 0xff]; // #7cc4ff
const GRAD_BOT = [0x2b, 0x6e, 0xf2]; // #2b6ef2
const EYE_WHITE = [0xff, 0xff, 0xff];
const EYE_PUPIL = [0x17, 0x3a, 0x63]; // #173a63
const EYES = [
  { cx: 14.8, cy: 24.5, r: 3.1, color: EYE_WHITE },
  { cx: 25.2, cy: 24.5, r: 3.1, color: EYE_WHITE },
  { cx: 15.5, cy: 25.1, r: 1.55, color: EYE_PUPIL },
  { cx: 25.9, cy: 25.1, r: 1.55, color: EYE_PUPIL },
];
// Gradient spans the stroked shape's vertical extent.
const GRAD_Y0 = TRI[0][1] - ROUND;
const GRAD_Y1 = TRI[1][1] + ROUND;

// ---------------------------------------------------------------------------
// SDF helpers (iq's exact triangle distance)
// ---------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function sdTriangle(px, py, [p0, p1, p2]) {
  const e = [
    [p1[0] - p0[0], p1[1] - p0[1]],
    [p2[0] - p1[0], p2[1] - p1[1]],
    [p0[0] - p2[0], p0[1] - p2[1]],
  ];
  const v = [
    [px - p0[0], py - p0[1]],
    [px - p1[0], py - p1[1]],
    [px - p2[0], py - p2[1]],
  ];
  const s = Math.sign(e[0][0] * e[2][1] - e[0][1] * e[2][0]);
  let dx = Infinity;
  let dy = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = clamp01(
      (v[i][0] * e[i][0] + v[i][1] * e[i][1]) / (e[i][0] * e[i][0] + e[i][1] * e[i][1]),
    );
    const qx = v[i][0] - e[i][0] * t;
    const qy = v[i][1] - e[i][1] * t;
    const dist2 = qx * qx + qy * qy;
    const side = s * (v[i][0] * e[i][1] - v[i][1] * e[i][0]);
    // component-wise min, mirroring iq's vec2 min
    dx = Math.min(dx, dist2);
    dy = Math.min(dy, side);
  }
  return -Math.sqrt(dx) * Math.sign(dy);
}

// ---------------------------------------------------------------------------
// Rasterize one size (supersampled)
// ---------------------------------------------------------------------------
function renderRgba(size, ss = 4) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 40 / size; // px -> viewBox units
  const inv = 1 / (ss * ss);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) * scale;
          const uy = (y + (sy + 0.5) / ss) * scale;
          const d = sdTriangle(ux, uy, TRI) - ROUND;
          if (d > 0) continue; // outside the rounded triangle
          // body: vertical gradient
          const t = clamp01((uy - GRAD_Y0) / (GRAD_Y1 - GRAD_Y0));
          let cr = GRAD_TOP[0] + (GRAD_BOT[0] - GRAD_TOP[0]) * t;
          let cg = GRAD_TOP[1] + (GRAD_BOT[1] - GRAD_TOP[1]) * t;
          let cb = GRAD_TOP[2] + (GRAD_BOT[2] - GRAD_TOP[2]) * t;
          for (const eye of EYES) {
            const dd = Math.hypot(ux - eye.cx, uy - eye.cy) - eye.r;
            if (dd <= 0) [cr, cg, cb] = eye.color;
          }
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const o = (y * size + x) * 4;
      const alpha = a * inv;
      if (alpha > 0) {
        // PNG wants straight (non-premultiplied) RGBA.
        rgba[o] = Math.round((r * inv * 255) / alpha);
        rgba[o + 1] = Math.round((g * inv * 255) / alpha);
        rgba[o + 2] = Math.round((b * inv * 255) / alpha);
        rgba[o + 3] = Math.round(alpha);
      }
    }
  }
  return rgba;
}

/** Monochrome template image: macOS supplies light/dark menu-bar coloring. */
function renderTemplateRgba(size, ss = 4) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 40 / size;
  const inv = 1 / (ss * ss);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) * scale;
          const uy = (y + (sy + 0.5) / ss) * scale;
          if (sdTriangle(ux, uy, TRI) - ROUND > 0) continue;
          const inEye =
            Math.hypot(ux - EYES[0].cx, uy - EYES[0].cy) <= EYES[0].r ||
            Math.hypot(ux - EYES[1].cx, uy - EYES[1].cy) <= EYES[1].r;
          if (!inEye) alpha += 255;
        }
      }
      rgba[(y * size + x) * 4 + 3] = Math.round(alpha * inv);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA8, filter 0)
// ---------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO container (PNG-compressed entries — supported since Vista)
// ---------------------------------------------------------------------------
const SIZES = [16, 32, 48, 256];
const pngs = SIZES.map((s) => encodePng(s, renderRgba(s)));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);

let offset = 6 + 16 * SIZES.length;
const entries = SIZES.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; // width (0 = 256)
  e[1] = s === 256 ? 0 : s; // height
  e[2] = 0; // palette
  e[3] = 0; // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});

writeFileSync(ICO_OUT, Buffer.concat([header, ...entries, ...pngs]));

// Modern ICNS files store PNG-compressed representations in named chunks.
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICNS_TYPES = ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10'];
const icnsChunks = ICNS_SIZES.map((size, index) => {
  const data = encodePng(size, renderRgba(size));
  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(ICNS_TYPES[index], 0, 'ascii');
  chunk.writeUInt32BE(chunk.length, 4);
  data.copy(chunk, 8);
  return chunk;
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 'ascii');
icnsHeader.writeUInt32BE(8 + icnsChunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
writeFileSync(ICNS_OUT, Buffer.concat([icnsHeader, ...icnsChunks]));

writeFileSync(TRAY_OUT, encodePng(18, renderTemplateRgba(18, 8)));
writeFileSync(TRAY_2X_OUT, encodePng(36, renderTemplateRgba(36, 8)));

console.log(
  `wrote ${path.basename(ICO_OUT)}, ${path.basename(ICNS_OUT)}, ` +
    `${path.basename(TRAY_OUT)}, ${path.basename(TRAY_2X_OUT)}`,
);
