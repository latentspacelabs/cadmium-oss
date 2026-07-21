const assert = require('assert');
const { LINE_LAYER, COLOR_LAYER } = require('../harness/driver');
const { colorClose } = require('../harness/png-utils');
const { SAMPLES } = require('../harness/fixtures');

module.exports = {
  name: 'paint bucket fills the color frame (create reference by hand)',
  // The fill is server-backed: it fetches a segmentation map (floodFill6) and
  // aborts without one — so this whole spec needs the ML server.
  ml: true,
  async run(d, { fixtures }) {
    await d.importImages([fixtures.lineA]);
    assert.strictEqual((await d.frames(LINE_LAYER)).length, 1);

    // Fill only writes when the COLOR layer is active.
    await d.commit('set_active_layer_id', COLOR_LAYER);
    await d.activateTool('fill');
    await d.commit('set_selected_color', '#dc2828');

    // Click the center of the drawing canvas — inside the square outline. The
    // fill lands on the color layer: its frame's record gains real bytes.
    // (Verified-click: the fill round-trips to the ML server, so give each
    // attempt time to settle.)
    const colorFrame = await d.clickElementUntil('.main-pane__canvas-inner-wrapper', 0.5, 0.5, `
      const f = s.state.layers.${COLOR_LAYER}.frames.filter(Boolean)[0];
      if (!f || !f.imageDataId) return null;
      const rec = s.state.ImageStore.imageDataById[f.imageDataId];
      return (rec && rec.dataUri) ? { imageDataId: f.imageDataId, isOriginal: !!f.isOriginal } : null;
    `, { settleMs: 30000 });

    const inside = await d.pixelFromRecord(colorFrame.imageDataId, SAMPLES.squareInside.x, SAMPLES.squareInside.y);
    assert.ok(inside && colorClose(inside, [220, 40, 40]), `fill color inside square, got ${inside}`);
    const outside = await d.pixelFromRecord(colorFrame.imageDataId, SAMPLES.squareOutside.x, SAMPLES.squareOutside.y);
    assert.ok(outside && (outside[3] < 128 || !colorClose(outside, [220, 40, 40])), `outside must not be filled, got ${outside}`);

    // A hand-painted frame is an ORIGINAL — it can serve as a colorize
    // reference.
    assert.strictEqual(colorFrame.isOriginal, true, 'painted frame is original');

    // Undo removes the fill; redo restores it (canvas undo boundary closes on
    // mouse-up).
    await d.dispatch('undo_action');
    const afterUndo = await d.storeEval(`
      const f = s.state.layers.${COLOR_LAYER}.frames.filter(Boolean)[0];
      if (!f || !f.imageDataId) return { hasBytes: false };
      const rec = s.state.ImageStore.imageDataById[f.imageDataId];
      return { hasBytes: !!(rec && rec.dataUri) };
    `);
    assert.strictEqual(afterUndo.hasBytes, false, 'undo removed the fill');

    await d.dispatch('redo_action');
    const afterRedo = await d.storeEval(`
      const f = s.state.layers.${COLOR_LAYER}.frames.filter(Boolean)[0];
      if (!f || !f.imageDataId) return { hasBytes: false };
      const rec = s.state.ImageStore.imageDataById[f.imageDataId];
      return { hasBytes: !!(rec && rec.dataUri) };
    `);
    assert.strictEqual(afterRedo.hasBytes, true, 'redo restored the fill');
  },
};
