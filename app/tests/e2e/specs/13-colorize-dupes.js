const assert = require('assert');
const { COLOR_LAYER, LINE_LAYER } = require('../harness/driver');

module.exports = {
  name: 'colorize-all reuses one color drawing per duplicate line drawing',
  ml: true,
  async run(d, { fixtures }) {
    // A B A(dup) A(dup) C — the A drawing appears on frames 1, 3, 4.
    await d.importImages([
      fixtures.lineA, fixtures.lineB, fixtures.lineADup, fixtures.lineA, fixtures.lineC,
    ]);
    const refId = await d.setColorFrame(1, fixtures.colorA);

    await d.commit('set_analyze_mode_only', false);
    await d.commit('set_frames_selected_on_whole_layer', { layerId: COLOR_LAYER, isSelected: true });

    await d.dispatch('colorize', undefined, { fire: true });
    await d.idle({ timeout: 600000 });

    const dlg = await d.openDialog();
    if (dlg) { await d.dismissDialog(); throw new Error(`colorize raised: "${dlg.title}" — ${dlg.message}`); }

    const lines = await d.frames(LINE_LAYER);
    const colors = await d.storeEval(`
      return s.state.layers.${COLOR_LAYER}.frames.filter(Boolean).map(f => {
        const rec = f.imageDataId ? s.state.ImageStore.imageDataById[f.imageDataId] : null;
        return { frameNr: f.frameNr, id: f.imageDataId, orig: !!f.isOriginal, hasBytes: !!(rec && rec.dataUri) };
      });
    `);
    assert.ok(colors.every((f) => f.hasBytes), 'every frame ended up colored');

    // Dupe reuse: line frames sharing a drawing share ONE colorized drawing.
    // Frames 3 and 4 (the A dupes) must point at the same color record; the
    // hand-painted frame 1 keeps its own.
    const c3 = colors.find((f) => f.frameNr === 3);
    const c4 = colors.find((f) => f.frameNr === 4);
    assert.strictEqual(c3.id, c4.id, 'duplicate line frames share one colorized drawing');
    const c1 = colors.find((f) => f.frameNr === 1);
    assert.strictEqual(c1.id, refId, 'hand-painted reference untouched by colorize-all');

    // Efficiency proxy for "one server call per unique drawing": no more
    // unique color drawings than unique line drawings.
    const uniqueLine = new Set(lines.map((f) => f.imageDataId)).size;
    const uniqueColor = new Set(colors.map((f) => f.id)).size;
    assert.ok(uniqueColor <= uniqueLine,
      `expected ≤${uniqueLine} unique color drawings, got ${uniqueColor}`);
  },
};
