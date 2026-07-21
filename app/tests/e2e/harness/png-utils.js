/*
 * PNG assertions for exported files on disk.
 */
const fs = require('fs');
const { PNG } = require('pngjs');

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function pixelAt(png, x, y) {
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

// True when a and b are within `tol` per channel (rgb only unless alpha given).
function colorClose(a, b, tol = 12) {
  const n = Math.min(a.length, b.length, 3);
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(a[i] - b[i]) > tol) return false;
  }
  return true;
}

// Set of distinct opaque colors, sampled on a grid (cheap, good enough for
// flat-color art). Returns array of [r,g,b].
function distinctColors(png, step = 7) {
  const seen = new Map();
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const [r, g, b, a] = pixelAt(png, x, y);
      if (a < 128) continue;
      seen.set(`${r},${g},${b}`, [r, g, b]);
    }
  }
  return [...seen.values()];
}

// Fraction of grid-sampled opaque pixels that are close to `color`.
function colorCoverage(png, color, tol = 12, step = 7) {
  let hits = 0;
  let total = 0;
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const px = pixelAt(png, x, y);
      if (px[3] < 128) continue;
      total += 1;
      if (colorClose(px, color, tol)) hits += 1;
    }
  }
  return total ? hits / total : 0;
}

module.exports = { readPng, pixelAt, colorClose, distinctColors, colorCoverage };
