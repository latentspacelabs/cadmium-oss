const assert = require('assert');
const { LINE_LAYER } = require('../harness/driver');

module.exports = {
  name: 'selection is dupe-linked; deleting a dupe group frees only its own drawing',
  async run(d, { fixtures }) {
    // Frame 1 = A, 2 = B, 3 = A (byte-identical dupe).
    await d.importImages([fixtures.lineA, fixtures.lineB, fixtures.lineADup]);
    const before = await d.frames(LINE_LAYER);
    const aId = before[0].imageDataId;
    const bId = before[1].imageDataId;

    // Toggling frame 1 selects EVERY frame sharing its drawing — the
    // dupe-linked selection contract (TOGGLE_FRAME_SELECTION propagates via
    // FRAME_IDS_OF_FRAMES_WITH_SAME_IMAGE_DATA_ID).
    await d.dispatch('toggle_frame_selection', { layerId: LINE_LAYER, frameNr: 1 });
    const selected = (await d.frames(LINE_LAYER)).filter((f) => f.isSelected);
    assert.deepStrictEqual(selected.map((f) => f.frameNr), [1, 3], 'both A frames selected together');

    // Selection is undoable (coalesced): one undo clears the toggle, redo
    // restores it.
    await d.dispatch('undo_action');
    assert.strictEqual((await d.frames(LINE_LAYER)).filter((f) => f.isSelected).length, 0,
      'undo cleared the selection');
    await d.dispatch('redo_action');
    assert.deepStrictEqual(
      (await d.frames(LINE_LAYER)).filter((f) => f.isSelected).map((f) => f.frameNr),
      [1, 3],
      'redo restored the dupe-linked selection',
    );

    // Deleting the selection removes the whole A group; B must survive with
    // its bytes intact (the dupe-refcount factory bug was freeing shared
    // records at the wrong time).
    await d.dispatch('handle_frame_delete');
    const after = await d.frames(LINE_LAYER);
    assert.strictEqual(after.length, 1, `expected only B to remain, got ${JSON.stringify(after)}`);
    assert.strictEqual(after[0].imageDataId, bId, 'survivor is B');
    const bRec = await d.imageRecord(bId);
    assert.ok(bRec && bRec.hasBytes, 'B record still has bytes');

    // A's record is fully released (both A frames are gone).
    const aRec = await d.imageRecord(aId);
    assert.ok(!aRec || !aRec.hasBytes, 'A record freed after its whole dupe group was deleted');

    // Select-all + delete empties the timeline.
    await d.commit('set_frames_selected_on_whole_layer', { layerId: LINE_LAYER, isSelected: true });
    await d.dispatch('handle_frame_delete');
    assert.strictEqual((await d.frames(LINE_LAYER)).length, 0, 'timeline empty after deleting all');
  },
};
