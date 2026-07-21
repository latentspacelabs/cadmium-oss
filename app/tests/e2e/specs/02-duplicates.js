const assert = require('assert');
const { LINE_LAYER } = require('../harness/driver');

module.exports = {
  name: 'duplicate frames share one drawing (content-hash dedupe)',
  async run(d, { fixtures }) {
    // A, B, byte-identical copy of A, A again, C  → dupes at frames 3 and 4.
    await d.importImages([
      fixtures.lineA, fixtures.lineB, fixtures.lineADup, fixtures.lineA, fixtures.lineC,
    ]);

    const lines = await d.frames(LINE_LAYER);
    assert.strictEqual(lines.length, 5);

    const [a1, b, a2, a3, c] = lines;
    assert.strictEqual(a2.imageDataId, a1.imageDataId, 'byte-identical file reuses the drawing');
    assert.strictEqual(a3.imageDataId, a1.imageDataId, 'same file again reuses the drawing');
    assert.notStrictEqual(b.imageDataId, a1.imageDataId);
    assert.notStrictEqual(c.imageDataId, a1.imageDataId);

    // Imported LINE frames are all originals — the original/duplicate
    // distinction lives on the color layer (colorized copies of a reference
    // are the non-originals). Dupe detection on line frames shows up as
    // shared drawings (above), not as an originality flag.
    assert.ok(lines.every((f) => f.isOriginal), 'imported line frames are all original');

    const rec = await d.imageRecord(a1.imageDataId);
    assert.ok(rec.hasBytes && rec.hash, 'shared record intact');
  },
};
