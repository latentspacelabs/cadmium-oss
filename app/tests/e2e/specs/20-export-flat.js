const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readPng, pixelAt } = require('../harness/png-utils');
const { SAMPLES } = require('../harness/fixtures');

module.exports = {
  name: 'export flat PNGs (dialog-free filePath entry)',
  async run(d, { fixtures, artifactsDir }) {
    await d.importImages([fixtures.lineA, fixtures.lineB]);

    const outDir = path.join(artifactsDir, 'export-flat');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'out.png');

    await d.dispatch('export_dialog', { kind: 'flat', filePath: target }, { fire: true });
    await d.idle({ timeout: 120000 });

    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).sort();
    assert.strictEqual(files.length, 2, `expected 2 exported frames, got: ${files.join(', ')}`);

    const png1 = readPng(path.join(outDir, files[0]));
    assert.strictEqual(png1.width, 512);
    assert.strictEqual(png1.height, 384);

    // Frame 1 is the square outline: edge opaque dark; interior is empty
    // (transparent or light — the line fixture has a transparent background).
    const edge = pixelAt(png1, 96 + 2, 192);
    const inside = pixelAt(png1, SAMPLES.squareInside.x, SAMPLES.squareInside.y);
    assert.ok(edge[3] > 128, `square edge should be opaque, got ${edge}`);
    assert.ok(edge[0] < 80 && edge[1] < 80 && edge[2] < 80, `square edge should be dark, got ${edge}`);
    assert.ok(inside[3] < 128 || inside[0] > 200, `square interior should be empty/light, got ${inside}`);
  },
};
