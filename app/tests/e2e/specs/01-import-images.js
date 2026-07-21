const assert = require('assert');
const { LINE_LAYER, COLOR_LAYER } = require('../harness/driver');

module.exports = {
  name: 'import images onto the line layer',
  async run(d, { fixtures }) {
    await d.importImages([fixtures.lineA, fixtures.lineB, fixtures.lineC]);

    const lines = await d.frames(LINE_LAYER);
    assert.strictEqual(lines.length, 3, `expected 3 line frames, got ${lines.length}`);
    assert.deepStrictEqual(lines.map((f) => f.frameNr), [1, 2, 3]);
    assert.ok(lines.every((f) => f.imageDataId), 'every line frame has an imageDataId');
    assert.ok(lines.every((f) => f.isOriginal), 'distinct images are all originals');
    assert.ok(lines.every((f) => !f.isLoading), 'no frame stuck loading');
    assert.strictEqual(new Set(lines.map((f) => f.imageDataId)).size, 3, 'distinct drawings get distinct ids');

    for (const f of lines) {
      const rec = await d.imageRecord(f.imageDataId);
      assert.ok(rec && rec.hasBytes, `record ${f.imageDataId} carries bytes`);
      assert.ok(rec.hash, `record ${f.imageDataId} carries a hash`);
    }

    // Canvas adopts the fixture dimensions.
    const dims = await d.storeEval('return { w: s.state.canvasWidth, h: s.state.canvasHeight };');
    assert.deepStrictEqual(dims, { w: 512, h: 384 });

    // A line import must not fabricate colored frames with bytes.
    const colors = await d.frames(COLOR_LAYER);
    for (const f of colors) {
      const rec = f.imageDataId ? await d.imageRecord(f.imageDataId) : null;
      assert.ok(!rec || !rec.hasBytes, `color frame ${f.frameNr} should be empty/ghost after line import`);
    }
  },
};
