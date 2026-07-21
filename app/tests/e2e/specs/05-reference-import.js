const assert = require('assert');

module.exports = {
  name: 'import a reference image into the reference panel',
  async run(d, { fixtures }) {
    await d.loadReference(fixtures.refA);

    const refs = await d.storeEval(`
      return s.state.referenceImages.map(r => ({
        name: r.name, width: r.width, height: r.height,
        hasData: !!r.b64Data, selected: !!r.selected,
      }));
    `);
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].name, 'ref-a.png');
    assert.strictEqual(refs[0].width, 512);
    assert.strictEqual(refs[0].height, 384);
    assert.ok(refs[0].hasData, 'reference carries image data');

    // A second reference appends, not replaces.
    await d.loadReference(fixtures.refB);
    const count = await d.storeEval('return s.state.referenceImages.length;');
    assert.strictEqual(count, 2);

    // Reference adds are undoable.
    await d.dispatch('undo_action');
    assert.strictEqual(await d.storeEval('return s.state.referenceImages.length;'), 1, 'undo removed the added reference');
    await d.dispatch('redo_action');
    assert.strictEqual(await d.storeEval('return s.state.referenceImages.length;'), 2, 'redo restored it');
  },
};
