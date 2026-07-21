const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readPng, colorCoverage, distinctColors } = require('../harness/png-utils');
const { LINE_LAYER } = require('../harness/driver');

function pngsUnder(dir) {
  const out = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.png')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

module.exports = {
  name: 'export colors separated writes one pass per palette color',
  async run(d, { fixtures, artifactsDir }) {
    // Line frame + a hand-built color frame (red square) + a 1-color palette —
    // the same state a paint-bucket reference produces, minus the ML fill.
    await d.importImages([fixtures.lineA]);
    await d.setColorFrame(1, fixtures.colorA);
    await d.addPaletteColor('#dc2828');

    const outDir = path.join(artifactsDir, 'export-separated');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'out.png');

    await d.dispatch('export_dialog', { kind: 'colors-separated', filePath: target }, { fire: true });
    await d.idle({ timeout: 120000 });

    const dlg = await d.openDialog();
    if (dlg && /export/i.test(dlg.title)) {
      await d.dismissDialog();
      throw new Error(`export raised: "${dlg.title}" — ${dlg.message}`);
    }

    const files = pngsUnder(outDir);
    assert.ok(files.length >= 1, `expected at least one color-pass png, dir has: ${files.join(', ') || 'nothing'}`);
    // One palette color + one frame → exactly one pass file.
    assert.strictEqual(files.length, 1, `expected exactly 1 pass file, got: ${files.join(', ')}`);
    assert.ok(/color01/.test(files[0]), `pass file should carry the color01 tag, got ${files[0]}`);

    const png = readPng(files[0]);
    assert.strictEqual(png.width, 512);
    // The red pass must contain a solid red region (the square interior) and
    // nothing of any other opaque color.
    const redShare = colorCoverage(png, [220, 40, 40]);
    assert.ok(redShare > 0.2, `red pass should be mostly the red region, coverage=${redShare}`);
    const others = distinctColors(png).filter((c) => !(Math.abs(c[0] - 220) < 13 && Math.abs(c[1] - 40) < 13 && Math.abs(c[2] - 40) < 13));
    assert.deepStrictEqual(others, [], `red pass contains foreign colors: ${JSON.stringify(others)}`);
  },
};
