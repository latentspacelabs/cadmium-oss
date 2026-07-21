const assert = require('assert');
const path = require('path');
const { LINE_LAYER } = require('../harness/driver');

module.exports = {
  name: 'save/load .cdm round-trips frames, dupes, and bytes',
  async run(d, { fixtures, artifactsDir }) {
    await d.importImages([fixtures.lineA, fixtures.lineB, fixtures.lineADup]);
    const before = await d.frames(LINE_LAYER);

    const cdmPath = path.join(artifactsDir, 'roundtrip.cdm');
    await d.saveProject(cdmPath);

    await d.resetProject();
    assert.strictEqual((await d.frames(LINE_LAYER)).length, 0);

    await d.loadProject(cdmPath);
    const after = await d.frames(LINE_LAYER);

    assert.strictEqual(after.length, before.length, 'frame count round-trips');
    assert.deepStrictEqual(after.map((f) => f.frameNr), before.map((f) => f.frameNr));
    assert.deepStrictEqual(
      after.map((f) => f.isOriginal),
      before.map((f) => f.isOriginal),
      'originality flags round-trip',
    );
    // Dupe structure: frames 1 and 3 still share one drawing.
    assert.strictEqual(after[0].imageDataId, after[2].imageDataId, 'dupe pair still shares a drawing');
    assert.notStrictEqual(after[0].imageDataId, after[1].imageDataId);

    for (const f of after) {
      const rec = await d.imageRecord(f.imageDataId);
      assert.ok(rec && rec.hasBytes, `frame ${f.frameNr} record has bytes after load`);
    }
    assert.ok(after.every((f) => !f.isLoading), 'no stale isLoading after load');
  },
};
