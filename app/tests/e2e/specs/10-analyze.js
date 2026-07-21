const assert = require('assert');
const { COLOR_LAYER } = require('../harness/driver');

module.exports = {
  name: 'analyze renders a flat-color pass onto the color frame',
  ml: true,
  async run(d, { fixtures }) {
    await d.importImages([fixtures.lineA]);

    // Analyze = COLORIZE with analyzeModeOnly on (the FooterBar button's
    // exact flow). It is the state default, but set it explicitly — the flag
    // is sticky session state.
    await d.commit('set_analyze_mode_only', true);
    await d.commit('set_frame_selected', { layerId: COLOR_LAYER, frameNr: 1, isSelected: true });
    await d.dispatch('colorize', undefined, { fire: true });
    await d.idle({ timeout: 300000 });

    const dlg = await d.openDialog();
    if (dlg) { await d.dismissDialog(); throw new Error(`analyze raised: "${dlg.title}" — ${dlg.message}`); }

    const frame = await d.waitUntil(`
      const f = s.state.layers.${COLOR_LAYER}.frames.filter(Boolean)[0];
      if (!f || !f.imageDataId) return null;
      const rec = s.state.ImageStore.imageDataById[f.imageDataId];
      return (rec && rec.dataUri) ? { imageDataId: f.imageDataId, isLoading: !!f.isLoading } : null;
    `, { timeout: 30000, desc: 'analyze render stored on color frame' });
    assert.strictEqual(frame.isLoading, false, 'no stuck isLoading after analyze');

    // The analyze render is a real image of canvas size.
    const px = await d.pixelFromRecord(frame.imageDataId, 256, 192);
    assert.ok(Array.isArray(px), 'analyze render decodes');
  },
};
