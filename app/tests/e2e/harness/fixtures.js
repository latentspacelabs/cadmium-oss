/*
 * Deterministic PNG fixtures for the e2e suite. Everything is generated from
 * code (no binary blobs in git, no randomness), so runs are repeatable and
 * dupe tests can rely on byte-identical copies.
 *
 * Geometry is shared between the line fixtures and their colored reference
 * counterparts so ML colorize gets a reference that actually matches.
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const W = 512;
const H = 384;

// Region geometry (image space) — exported so specs can sample inside shapes.
const SQUARE = { x0: 96, y0: 72, x1: 416, y1: 312 }; // rectangle bounds
const CIRCLE = { cx: 256, cy: 192, r: 120 };
const STROKE = 5;

const RED = [220, 40, 40];
const BLUE = [40, 80, 220];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// alpha=0 → transparent canvas (required for LINE imports: the importer
// rejects line art without transparent pixels); alpha=255 → opaque white.
function blank(alpha) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = alpha;
  }
  return png;
}

function put(png, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (W * y + x) * 4;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
}

function paint(png, colorAt) {
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const c = colorAt(x, y);
      if (c) put(png, x, y, c);
    }
  }
}

const inSquare = (x, y) => x >= SQUARE.x0 && x <= SQUARE.x1 && y >= SQUARE.y0 && y <= SQUARE.y1;
const onSquareEdge = (x, y) => inSquare(x, y) && (
  x - SQUARE.x0 < STROKE || SQUARE.x1 - x < STROKE
  || y - SQUARE.y0 < STROKE || SQUARE.y1 - y < STROKE
);
const circleDist = (x, y) => Math.hypot(x - CIRCLE.cx, y - CIRCLE.cy);
const onCircleEdge = (x, y) => Math.abs(circleDist(x, y) - CIRCLE.r) < STROKE / 2 + 1;
const inCircle = (x, y) => circleDist(x, y) < CIRCLE.r;
const onTriangleEdge = (x, y) => {
  // Triangle (256,60) (96,320) (416,320): near any of the three segments.
  const segs = [[256, 60, 96, 320], [96, 320, 416, 320], [416, 320, 256, 60]];
  return segs.some(([ax, ay, bx, by]) => {
    const t = Math.max(0, Math.min(1,
      ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    const dx = x - (ax + t * (bx - ax));
    const dy = y - (ay + t * (by - ay));
    return Math.hypot(dx, dy) < STROKE / 2 + 1;
  });
};

function write(png, file) {
  fs.writeFileSync(file, PNG.sync.write(png));
}

// Generates all fixtures into dir. Idempotent; returns the path map.
function generateFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = (name) => path.join(dir, name);

  // Line art: black strokes on a TRANSPARENT background (the importer rejects
  // line frames without transparent pixels).
  const lineA = blank(0);
  paint(lineA, (x, y) => (onSquareEdge(x, y) ? BLACK : null));
  write(lineA, p('line-a.png'));
  fs.copyFileSync(p('line-a.png'), p('line-a-dup.png')); // byte-identical dupe

  const lineB = blank(0);
  paint(lineB, (x, y) => (onCircleEdge(x, y) ? BLACK : null));
  write(lineB, p('line-b.png'));

  const lineC = blank(0);
  paint(lineC, (x, y) => (onTriangleEdge(x, y) ? BLACK : null));
  write(lineC, p('line-c.png'));

  // A color-layer frame as the paint bucket would produce it: RED inside the
  // square, transparent everywhere else.
  const colorA = blank(0);
  paint(colorA, (x, y) => (inSquare(x, y) && !onSquareEdge(x, y) ? RED : null));
  write(colorA, p('color-a.png'));

  // Colored references: flat fills on opaque white.
  const refA = blank(255);
  paint(refA, (x, y) => (onSquareEdge(x, y) ? BLACK : (inSquare(x, y) ? RED : null)));
  write(refA, p('ref-a.png'));

  const refB = blank(255);
  paint(refB, (x, y) => (onCircleEdge(x, y) ? BLACK : (inCircle(x, y) ? BLUE : null)));
  write(refB, p('ref-b.png'));

  return {
    lineA: p('line-a.png'),
    lineADup: p('line-a-dup.png'),
    lineB: p('line-b.png'),
    lineC: p('line-c.png'),
    colorA: p('color-a.png'),
    refA: p('ref-a.png'),
    refB: p('ref-b.png'),
  };
}

// Interior sample points, safely away from outlines.
const SAMPLES = {
  squareInside: { x: 256, y: 192 },
  squareOutside: { x: 20, y: 20 },
  circleInside: { x: 256, y: 192 },
  triangleInside: { x: 256, y: 260 },
};

module.exports = {
  generateFixtures, W, H, SQUARE, CIRCLE, SAMPLES, RED, BLUE, WHITE, BLACK,
};
