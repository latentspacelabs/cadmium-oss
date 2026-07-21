/**
 * Smoke test: the store's actions module must LOAD.
 *
 * actions.js has file-level eslint-disable and no direct unit coverage, so a
 * broken import (an identifier removed while still referenced at module scope)
 * only surfaces when the app boots. This spec exists to catch that class of
 * breakage in jest — it found a real one during the phase-6 cleanup.
 */

describe('store/actions module', () => {
  it('imports without throwing and exposes the action handlers', () => {
    /* eslint-disable-next-line global-require */
    const actions = require('@/store/actions').default;
    expect(typeof actions).toBe('object');
    expect(typeof actions.colorize).toBe('function');
    expect(typeof actions.export_dialog).toBe('function');
    expect(typeof actions.add_images_to_timeline).toBe('function');
  });
});
