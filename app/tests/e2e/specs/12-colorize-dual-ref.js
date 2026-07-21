const assert = require('assert');
const { COLOR_LAYER } = require('../harness/driver');

module.exports = {
  name: 'colorize between two references (dual-ref matching)',
  ml: true,
  async run(d, { fixtures }) {
    // References at BOTH ends of the range: frames 1 and 4 hand-painted,
    // 2 and 3 colorized between them — reference matching resolves a
    // before/after pair for each target.
    await d.importImages([fixtures.lineA, fixtures.lineB, fixtures.lineC, fixtures.lineA]);
    await d.setColorFrame(1, fixtures.colorA);
    await d.setColorFrame(4, fixtures.colorA);

    await d.commit('set_analyze_mode_only', false);
    await d.commit('set_frame_selected', { layerId: COLOR_LAYER, frameNr: 2, isSelected: true });
    await d.commit('set_frame_selected', { layerId: COLOR_LAYER, frameNr: 3, isSelected: true });

    await d.dispatch('colorize', undefined, { fire: true });
    await d.idle({ timeout: 600000 });

    const dlg = await d.openDialog();
    if (dlg) { await d.dismissDialog(); throw new Error(`colorize raised: "${dlg.title}" — ${dlg.message}`); }

    const frames = await d.storeEval(`
      return s.state.layers.${COLOR_LAYER}.frames.filter(Boolean).map(f => {
        const rec = f.imageDataId ? s.state.ImageStore.imageDataById[f.imageDataId] : null;
        return { frameNr: f.frameNr, orig: !!f.isOriginal, hasBytes: !!(rec && rec.dataUri) };
      });
    `);
    for (const nr of [2, 3]) {
      const f = frames.find((x) => x.frameNr === nr);
      assert.ok(f && f.hasBytes, `frame ${nr} colorized`);
      assert.strictEqual(f.orig, false, `frame ${nr} not original`);
    }
    for (const nr of [1, 4]) {
      const f = frames.find((x) => x.frameNr === nr);
      assert.strictEqual(f.orig, true, `reference frame ${nr} stays original`);
    }
  },
};
