const assert = require('assert');
const { COLOR_LAYER } = require('../harness/driver');

module.exports = {
  name: 'colorize selection from a single hand-painted reference',
  ml: true,
  async run(d, { fixtures }) {
    // Three DISTINCT drawings; frame 1 gets a hand-built color reference.
    await d.importImages([fixtures.lineA, fixtures.lineB, fixtures.lineC]);
    const refId = await d.setColorFrame(1, fixtures.colorA);

    await d.commit('set_analyze_mode_only', false); // sticky flag — must be off for real colorize
    // Commit-level selection (no dupe-linked propagation): frames 2 and 3.
    await d.commit('set_frame_selected', { layerId: COLOR_LAYER, frameNr: 2, isSelected: true });
    await d.commit('set_frame_selected', { layerId: COLOR_LAYER, frameNr: 3, isSelected: true });

    await d.dispatch('colorize', undefined, { fire: true });
    await d.idle({ timeout: 600000 });

    const dlg = await d.openDialog();
    if (dlg) { await d.dismissDialog(); throw new Error(`colorize raised: "${dlg.title}" — ${dlg.message}`); }

    const frames = await d.storeEval(`
      return s.state.layers.${COLOR_LAYER}.frames.filter(Boolean).map(f => {
        const rec = f.imageDataId ? s.state.ImageStore.imageDataById[f.imageDataId] : null;
        return { frameNr: f.frameNr, id: f.imageDataId, orig: !!f.isOriginal,
                 loading: !!f.isLoading, hasBytes: !!(rec && rec.dataUri) };
      });
    `);
    const f1 = frames.find((f) => f.frameNr === 1);
    const f2 = frames.find((f) => f.frameNr === 2);
    const f3 = frames.find((f) => f.frameNr === 3);

    assert.strictEqual(f1.id, refId, 'reference frame untouched');
    assert.strictEqual(f1.orig, true, 'reference stays original');
    for (const f of [f2, f3]) {
      assert.ok(f.hasBytes, `frame ${f.frameNr} got colorized bytes`);
      assert.strictEqual(f.orig, false, `frame ${f.frameNr} is a colorized copy, not an original`);
      assert.strictEqual(f.loading, false, `frame ${f.frameNr} not stuck loading`);
    }

    // Colorize populates the palette from the server response.
    const palette = await d.palette();
    assert.ok(palette.length > 0, 'palette populated by colorize');
  },
};
