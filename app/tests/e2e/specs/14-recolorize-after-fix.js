const assert = require('assert');
const { COLOR_LAYER } = require('../harness/driver');

module.exports = {
  name: 'paint-bucket fix promotes the frame to original; re-colorize uses it',
  ml: true,
  async run(d, { fixtures }) {
    // Three copies of the same drawing: ref at 1, colorize 2, fix 2, then
    // re-colorize 3 — which should follow the FIXED frame 2, not frame 1.
    await d.importImages([fixtures.lineA, fixtures.lineADup, fixtures.lineA]);
    await d.setColorFrame(1, fixtures.colorA);
    await d.commit('set_analyze_mode_only', false);

    // Colorize frame 2 only (commit-level selection avoids dupe-linked
    // propagation to frame 3).
    await d.commit('set_frame_selected', { layerId: COLOR_LAYER, frameNr: 2, isSelected: true });
    await d.dispatch('colorize', undefined, { fire: true });
    await d.idle({ timeout: 600000 });
    let dlg = await d.openDialog();
    if (dlg) { await d.dismissDialog(); throw new Error(`colorize raised: "${dlg.title}"`); }

    // "Fix the ML prediction": green paint bucket on frame 2.
    await d.commit('set_selected_frame_number', 2);
    await d.commit('set_active_layer_id', COLOR_LAYER);
    await d.activateTool('fill');
    await d.commit('set_selected_color', '#28b428');
    await d.clickElementUntil('.main-pane__canvas-inner-wrapper', 0.5, 0.5, `
      const f = s.state.layers.${COLOR_LAYER}.frames.filter(Boolean).find(x => x.frameNr === 2);
      return (f && f.isOriginal) ? { id: f.imageDataId } : null;
    `, { settleMs: 30000 });

    // Re-colorize frame 3; nearest original is now frame 2 (the fix).
    await d.commit('set_frame_selected', { layerId: COLOR_LAYER, frameNr: 3, isSelected: true });
    await d.dispatch('colorize', undefined, { fire: true });
    await d.idle({ timeout: 600000 });
    dlg = await d.openDialog();
    if (dlg) { await d.dismissDialog(); throw new Error(`re-colorize raised: "${dlg.title}"`); }

    const f3 = await d.storeEval(`
      const f = s.state.layers.${COLOR_LAYER}.frames.filter(Boolean).find(x => x.frameNr === 3);
      const rec = f && f.imageDataId ? s.state.ImageStore.imageDataById[f.imageDataId] : null;
      return f ? { id: f.imageDataId, orig: !!f.isOriginal, hasBytes: !!(rec && rec.dataUri) } : null;
    `);
    assert.ok(f3 && f3.hasBytes, 'frame 3 recolorized');
    assert.strictEqual(f3.orig, false, 'frame 3 is a copy');

    // The result should follow the FIX: center pixel closer to green than red.
    const px = await d.pixelFromRecord(f3.id, 256, 192);
    const distTo = (c) => Math.hypot(px[0] - c[0], px[1] - c[1], px[2] - c[2]);
    assert.ok(distTo([40, 180, 40]) < distTo([220, 40, 40]),
      `frame 3 center should follow the green fix, got rgba(${px})`);
  },
};
