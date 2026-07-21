const assert = require('assert');

module.exports = {
  name: 'reference panel eyedropper picks the clicked color',
  async run(d, { fixtures }) {
    // The reference panel is hidden by default — show it first.
    await d.commit('show_tool_control_with_id', 'referencepanel');
    await d.loadReference(fixtures.refA); // first ref auto-selects and draws

    // Wait until the reference is actually PAINTED (center pixel opaque) —
    // the canvas exists and resizes before the async image draw lands, and a
    // click on a still-transparent canvas picks the background instead.
    await d.waitUntil(`
      const c = document.getElementById('referenceCanvas');
      if (!(c && c.width > 1 && c.getBoundingClientRect().width > 1)) return false;
      const px = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return px[3] > 0;
    `, { timeout: 10000, desc: 'reference canvas painted (center opaque)' });

    // Poison the current color so the assertion can only pass via the pick.
    await d.commit('set_selected_color', '#123456');
    await d.activateTool('eyedropper');

    // Center of the reference = center of the red square (fixture geometry).
    const picked = await d.clickElementUntil('#referenceCanvas', 0.5, 0.5, `
      const c = g['selected_color'];
      return (c && c !== '#123456') ? c : null;
    `);
    assert.strictEqual(picked.toLowerCase(), '#dc2828', `expected fixture red, got ${picked}`);
  },
};
