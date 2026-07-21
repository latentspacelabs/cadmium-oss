const assert = require('assert');
const { colorClose } = require('../harness/png-utils');
const { SAMPLES } = require('../harness/fixtures');
const { COLOR_LAYER } = require('../harness/driver');

module.exports = {
  name: 'palette change recolors existing color frames (URI_CHANGE_COLOR)',
  async run(d, { fixtures }) {
    await d.importImages([fixtures.lineA]);
    const imageDataId = await d.setColorFrame(1, fixtures.colorA);
    await d.addPaletteColor('#dc2828');

    const before = await d.pixelFromRecord(imageDataId, SAMPLES.squareInside.x, SAMPLES.squareInside.y);
    assert.ok(colorClose(before, [220, 40, 40]), `precondition: square is red, got ${before}`);

    // Ask for red → green and commit to all frames.
    await d.storeEval(`
      const entry = s.state.colorPalette.find(e => e.hex === '#dc2828');
      if (!entry) return null;
      entry.newHex = '#28b428';
      return true;
    `);
    await d.dispatch('uri_change_color', { allFrames: true }, { fire: true });
    await d.idle({ timeout: 60000 });

    // Pixels swapped in place on the same drawing.
    const frame = await d.storeEval(`
      const f = s.state.layers.${COLOR_LAYER}.frames.filter(Boolean)[0];
      return f ? { imageDataId: f.imageDataId } : null;
    `);
    const after = await d.pixelFromRecord(frame.imageDataId, SAMPLES.squareInside.x, SAMPLES.squareInside.y);
    assert.ok(colorClose(after, [40, 180, 40]), `square should now be green, got ${after}`);

    // The palette entry follows: its hex is the new color.
    const palette = await d.palette();
    assert.ok(palette.some((e) => e.hex === '#28b428'), `palette should carry the new hex, got ${JSON.stringify(palette.map((e) => e.hex))}`);
    assert.ok(!palette.some((e) => e.hex === '#dc2828'), 'old hex swatch no longer present');
  },
};
