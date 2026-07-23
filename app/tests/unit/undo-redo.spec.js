// Integration tests for the Phase 6a undo/redo plugin against a REAL Vuex 3
// store. They prove the behavior contract that replaces the old whole-clone
// model (F5 in docs/architecture.md):
//   - undo restores the exact prior DOCUMENT state (the DIFF_SCOPE_KEYS slices),
//   - out-of-scope job/session keys are NEVER touched by undo, even when the
//     undone action also mutated them,
//   - redo reapplies, the stack caps at MAX_UNDO_ITEMS (20),
//   - non-undoable and empty-diff actions push nothing,
//   - loadcdm clears the stacks so a stale patch can't be applied post-load.
import Vue from 'vue';
import Vuex from 'vuex';
import { cloneDeep } from 'lodash';

import undoRedoPlugin, {
  undo,
  redo,
  loadcdm,
  closeUndoBoundary,
  DIFF_SCOPE_KEYS,
} from '@/store/undo-redo-plugin';
import {
  COLORIZE,
  HANDLE_DELETE_PRESS,
  CANVAS_ACTION,
  TOGGLE_FRAME_SELECTION,
} from '@/store/action-types';
import { APPLY_STATE_PATCH } from '@/store/mutation-types';
import { applyPatch } from '@/services/state-patch';

Vue.use(Vuex);

// ImageStore as a real Vuex module, so it lives at state.ImageStore.imageDataById
// exactly like production; its mutations mutate entries in place.
function imageStoreModule() {
  return {
    state: { imageDataById: {} },
    mutations: {
      addImage(s, { id, entry }) { Vue.set(s.imageDataById, id, entry); },
      editUri(s, { id, dataUri }) { s.imageDataById[id].dataUri = dataUri; },
      removeImage(s, id) { Vue.delete(s.imageDataById, id); },
    },
  };
}

function makeStore() {
  return new Vuex.Store({
    state: {
      layers: { L: { frames: [] } },
      layerGroups: [],
      colorPalette: [],
      firstRealFrameNumber: -1,
      lastRealFrameNumber: -1,
      tempFilePaths: [],
      referenceImages: [],
      // out-of-scope keys (must survive undo untouched):
      colorizationInProgress: false,
      selectedFrame: 1,
      unsavedChanges: false,
    },
    mutations: {
      setFrame(s, { i, frame }) { Vue.set(s.layers.L.frames, i, frame); },
      addColor(s, c) { s.colorPalette.push(c); },
      addRef(s, r) { s.referenceImages.push(r); },
      setUnsaved(s, v) { s.unsavedChanges = v; },
      setJob(s, v) { s.colorizationInProgress = v; },
      setSelected(s, v) { s.selectedFrame = v; },
      [APPLY_STATE_PATCH](s, patch) { applyPatch(s, patch); },
    },
    modules: { ImageStore: imageStoreModule() },
    actions: {
      // Undoable: mutates document AND out-of-scope keys. Accepts a payload so
      // we can dispatch it many times with distinct effects (cap test).
      [COLORIZE]({ commit }, payload = {}) {
        const hex = payload.hex || '#111';
        commit('addImage', { id: payload.id || 'img1', entry: { dataUri: 'A', hash: 'h' } });
        commit('setFrame', { i: 1, frame: { id: payload.id || 'img1', sel: false } });
        commit('addColor', { hex });
        // also mutate out-of-scope keys — undo must NOT revert these:
        commit('setJob', true);
        commit('setSelected', 5);
        commit('setUnsaved', true);
      },
      // Undoable: deletes the frame/image the COLORIZE above created.
      [HANDLE_DELETE_PRESS]({ commit }) {
        commit('setFrame', { i: 1, frame: undefined });
        commit('removeImage', 'img1');
      },
      // Undoable but only touches out-of-scope state -> empty diff (models a
      // CANVAS_ACTION mouse-down with no drawing committed).
      [CANVAS_ACTION]({ commit }) { commit('setUnsaved', true); },
      // Undoable selection action (coalescing + isSelected-only filter).
      [TOGGLE_FRAME_SELECTION]({ commit, state }, { i }) {
        const f = state.layers.L.frames[i];
        commit('setFrame', { i, frame: { ...(f || {}), isSelected: !(f && f.isSelected) } });
      },
      // Not in the undoable set.
      noop({ commit }) { commit('addColor', { hex: '#999' }); },
    },
    plugins: [undoRedoPlugin],
  });
}

// Deep snapshot of just the in-scope document slices.
const docScope = (store) => {
  const out = {};
  DIFF_SCOPE_KEYS.forEach((k) => { out[k] = cloneDeep(store.state[k]); });
  return out;
};

describe('undo/redo — document restore & isolation', () => {
  let store;
  beforeEach(() => { store = makeStore(); });

  it('undo restores the exact prior document scope; redo reapplies', async () => {
    const before = docScope(store);

    await store.dispatch(COLORIZE);
    const afterAction = docScope(store);
    expect(afterAction).not.toEqual(before);
    expect(store.state.colorPalette).toHaveLength(1);
    expect(store.state.ImageStore.imageDataById.img1).toBeDefined();

    undo();
    expect(docScope(store)).toEqual(before);
    expect(store.state.colorPalette).toHaveLength(0);
    expect(store.state.ImageStore.imageDataById.img1).toBeUndefined();

    redo();
    expect(docScope(store)).toEqual(afterAction);
    expect(store.state.colorPalette).toHaveLength(1);
    expect(store.state.ImageStore.imageDataById.img1).toBeDefined();
  });

  it('undo leaves out-of-scope job/session keys untouched', async () => {
    await store.dispatch(COLORIZE);
    expect(store.state.colorizationInProgress).toBe(true);
    expect(store.state.selectedFrame).toBe(5);
    expect(store.state.unsavedChanges).toBe(true);

    undo();
    // document reverted, but the out-of-scope keys keep their live values:
    expect(store.state.colorPalette).toHaveLength(0);
    expect(store.state.colorizationInProgress).toBe(true);
    expect(store.state.selectedFrame).toBe(5);
    expect(store.state.unsavedChanges).toBe(true);
  });

  it('applies patches via the APPLY_STATE_PATCH mutation (reactivity holds)', async () => {
    await store.dispatch(COLORIZE);
    // A reactive computed over the palette should update after undo.
    const vm = new Vue({ computed: { len() { return store.state.colorPalette.length; } } });
    expect(vm.len).toBe(1);
    undo();
    await Vue.nextTick();
    expect(vm.len).toBe(0);
  });

  it('multi-step undo/redo across two different undoable actions', async () => {
    const before = docScope(store);
    await store.dispatch(COLORIZE);              // add img1 + frame + color
    const afterColorize = docScope(store);
    await store.dispatch(HANDLE_DELETE_PRESS);   // remove them again
    const afterDelete = docScope(store);
    expect(afterDelete.ImageStore.imageDataById.img1).toBeUndefined();

    undo(); // undo delete
    expect(docScope(store)).toEqual(afterColorize);
    undo(); // undo colorize
    expect(docScope(store)).toEqual(before);

    redo(); // redo colorize
    expect(docScope(store)).toEqual(afterColorize);
    redo(); // redo delete
    expect(docScope(store)).toEqual(afterDelete);
  });
});

describe('undo/redo — what does and does not get pushed', () => {
  let store;
  beforeEach(() => { store = makeStore(); });

  it('non-undoable action pushes nothing', async () => {
    await store.dispatch('noop'); // adds a color, not undoable
    expect(store.state.colorPalette).toHaveLength(1);
    undo(); // nothing on the stack -> no-op
    expect(store.state.colorPalette).toHaveLength(1);
  });

  it('empty-diff undoable action pushes nothing', async () => {
    await store.dispatch(COLORIZE);        // real doc change (item)
    await store.dispatch(CANVAS_ACTION);   // out-of-scope only (empty diff)
    // A single undo must revert COLORIZE — proving CANVAS_ACTION pushed nothing.
    undo();
    expect(store.state.colorPalette).toHaveLength(0);
    expect(store.state.ImageStore.imageDataById.img1).toBeUndefined();
  });

  it('a new undoable action clears the redo stack', async () => {
    await store.dispatch(COLORIZE, { hex: '#aaa', id: 'a' });
    undo();
    expect(store.state.colorPalette).toHaveLength(0);
    // new undoable action invalidates the redo history:
    await store.dispatch(COLORIZE, { hex: '#bbb', id: 'b' });
    redo(); // should be a no-op (redo stack cleared)
    expect(store.state.colorPalette).toHaveLength(1);
    expect(store.state.colorPalette[0].hex).toBe('#bbb');
  });
});

describe('undo/redo — stack cap', () => {
  it(`caps history at 20 items (oldest dropped)`, async () => {
    const store = makeStore();
    for (let i = 0; i < 25; i += 1) {
      // each dispatch adds one distinct color -> one undo item
      // eslint-disable-next-line no-await-in-loop
      await store.dispatch(COLORIZE, { hex: `#${i}`, id: `id${i}` });
    }
    expect(store.state.colorPalette).toHaveLength(25);
    for (let i = 0; i < 25; i += 1) { undo(); }
    // only the 20 most-recent additions were undoable; 5 remain.
    expect(store.state.colorPalette).toHaveLength(5);
  });
});

describe('undo/redo — guards', () => {
  let store;
  beforeEach(() => { store = makeStore(); });

  it('undo/redo no-op while a colorization/update is in progress', async () => {
    await store.dispatch(COLORIZE);
    expect(store.state.colorPalette).toHaveLength(1);
    undo(true, false);   // ColorizationInProgress guard
    expect(store.state.colorPalette).toHaveLength(1);
    undo(false, true);   // UpdateColorsInProgress guard
    expect(store.state.colorPalette).toHaveLength(1);
    // once clear, undo works:
    undo(false, false);
    expect(store.state.colorPalette).toHaveLength(0);
    redo(true, false);   // redo guarded too
    expect(store.state.colorPalette).toHaveLength(0);
  });
});

describe('loadcdm — clears undo/redo history', () => {
  it('runs without throwing and leaves undo a safe no-op afterwards', async () => {
    const store = makeStore();
    await store.dispatch(COLORIZE); // create an open boundary + would-be item

    // Minimal but valid stateObject for loadcdm's legacy-normalisation logic.
    const loaded = {
      colorPalette: [{ hex: '#abcdef' }],
      PenTool: {},
      ToolControls: { toolControlItems: [], toolControlItemIds: [] },
      layers: {},
    };
    expect(() => loadcdm(loaded)).not.toThrow();
    expect(store.state.colorPalette).toEqual([expect.objectContaining({ hex: '#abcdef' })]);

    // Stacks were cleared: undo must not apply a stale pre-load patch.
    undo();
    expect(store.state.colorPalette).toEqual([expect.objectContaining({ hex: '#abcdef' })]);
  });

  it('preserves the running app\'s serverBackend over whatever the file carries', () => {
    const store = makeStore();
    const mine = { kind: 'hosted', baseUrl: 'http://my-machine:8000' };
    store.state.serverBackend = mine;

    // File saved on another machine (foreign backend) or pre-S1 (none at all).
    loadcdm({
      colorPalette: [],
      PenTool: {},
      ToolControls: { toolControlItems: [], toolControlItemIds: [] },
      layers: {},
      serverBackend: { kind: 'hosted', baseUrl: 'http://someone-elses-box:9999' },
    });
    expect(store.state.serverBackend).toEqual(mine);

    loadcdm({
      colorPalette: [],
      PenTool: {},
      ToolControls: { toolControlItems: [], toolControlItemIds: [] },
      layers: {},
    });
    expect(store.state.serverBackend).toEqual(mine);
  });

  it('re-seeds an embedded descriptor the same way — the runtime port never rides in a file', () => {
    const store = makeStore();
    // The embedded descriptor is URL-less by construction; the sidecar port
    // lives only in the main process. A file carrying a foreign hosted
    // backend (or a corrupted embedded one with a baked URL) must not win.
    const mine = { kind: 'embedded', baseUrl: '' };
    store.state.serverBackend = mine;

    loadcdm({
      colorPalette: [],
      PenTool: {},
      ToolControls: { toolControlItems: [], toolControlItemIds: [] },
      layers: {},
      serverBackend: { kind: 'embedded', baseUrl: 'http://127.0.0.1:53211' },
    });
    expect(store.state.serverBackend).toEqual(mine);

    loadcdm({
      colorPalette: [],
      PenTool: {},
      ToolControls: { toolControlItems: [], toolControlItemIds: [] },
      layers: {},
      serverBackend: { kind: 'hosted', baseUrl: 'http://someone-elses-box:9999' },
    });
    expect(store.state.serverBackend).toEqual(mine);
  });

  it('backfills aiGapCloserEnabled for pre-field files (absent key = non-reactive = dead toggle)', () => {
    const store = makeStore();
    loadcdm({
      colorPalette: [],
      PenTool: {},
      ToolControls: { toolControlItems: [], toolControlItemIds: [] },
      layers: {},
    });
    expect(store.state.aiGapCloserEnabled).toBe(true);

    // An explicit saved false must survive the backfill untouched.
    loadcdm({
      colorPalette: [],
      PenTool: {},
      ToolControls: { toolControlItems: [], toolControlItemIds: [] },
      layers: {},
      aiGapCloserEnabled: false,
    });
    expect(store.state.aiGapCloserEnabled).toBe(false);
  });
});

describe('selection undo — coalescing and isSelected-only filtering', () => {
  let store;
  beforeEach(() => {
    store = makeStore();
    // Baseline frames committed directly (no undo boundary).
    store.commit('setFrame', { i: 1, frame: { id: 'a', isSelected: false } });
    store.commit('setFrame', { i: 2, frame: { id: 'b', isSelected: false } });
    store.commit('setFrame', { i: 3, frame: { id: 'c', isSelected: false } });
  });
  const sel = (i) => store.state.layers.L.frames[i].isSelected;

  it('a selection toggle is undoable and redoable', async () => {
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 1 });
    expect(sel(1)).toBe(true);
    undo(false, false);
    expect(sel(1)).toBe(false);
    redo(false, false);
    expect(sel(1)).toBe(true);
  });

  it('a run of consecutive toggles coalesces into ONE undo item', async () => {
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 1 });
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 2 });
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 3 });
    undo(false, false); // one undo reverts the whole run
    expect([sel(1), sel(2), sel(3)]).toEqual([false, false, false]);
    redo(false, false); // one redo replays the whole run
    expect([sel(1), sel(2), sel(3)]).toEqual([true, true, true]);
  });

  it('non-selection writes landing mid-run are NOT swept into the selection item', async () => {
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 1 });
    await store.dispatch('noop'); // palette write while the selection boundary is open
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 2 });
    undo(false, false);
    expect([sel(1), sel(2)]).toEqual([false, false]);
    expect(store.state.colorPalette).toEqual([{ hex: '#999' }]); // survived the undo
  });

  it('a non-selection action closes the run: undo peels it before the selection', async () => {
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 2 });
    await store.dispatch(COLORIZE); // finalizes the selection boundary, then its own
    undo(false, false); // undoes COLORIZE only
    expect(sel(2)).toBe(true);
    expect(store.state.colorPalette).toEqual([]);
    undo(false, false); // now the selection run
    expect(sel(2)).toBe(false);
  });

  it('a net no-op run (toggle on, toggle off) pushes nothing', async () => {
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 1 });
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 1 });
    undo(false, false); // no selection item; nothing to revert
    expect([sel(1), sel(2), sel(3)]).toEqual([false, false, false]);
  });

  it('a selection dispatched inside an OPEN non-selection boundary is absorbed, not stolen', async () => {
    // Models the paint-bucket fill: CANVAS_ACTION opens the boundary on
    // mouse-down; the fill flow adds a palette color, dispatches a selection
    // action (ANALYZE_CURRENT_FRAME leads with DESELECT_ALL), commits the
    // image, and only then closes the boundary. All of it must land in ONE
    // undo item — the regression was the nested selection finalizing the
    // boundary half-done and its isSelected-only filter discarding the image.
    await store.dispatch(CANVAS_ACTION); // opens boundary; stays open
    store.commit('addColor', { hex: '#dc2828' });
    await store.dispatch(TOGGLE_FRAME_SELECTION, { i: 1 }); // nested sub-step
    store.commit('addImage', { id: 'fill1', entry: { dataUri: 'F', hash: 'hf' } });
    closeUndoBoundary(); // fill's mouse-down flow ends

    undo(false, false); // ONE undo reverts color + image + selection together
    expect(store.state.colorPalette).toEqual([]);
    expect(store.state.ImageStore.imageDataById.fill1).toBeUndefined();
    expect(sel(1)).toBe(false);

    redo(false, false);
    expect(store.state.colorPalette).toEqual([{ hex: '#dc2828' }]);
    expect(store.state.ImageStore.imageDataById.fill1).toEqual({ dataUri: 'F', hash: 'hf' });
    expect(sel(1)).toBe(true);
  });
});

describe('boundary closes at action settle (no sweep of later writes)', () => {
  it('a DISJOINT non-undoable write after settle survives undo and is not in the item', async () => {
    const store = makeStore();
    await store.dispatch(COLORIZE, { id: 'imgS', hex: '#123' });

    // A non-undoable write in a scope slice the colorize did NOT touch. Under
    // the old finalize-at-next-boundary model this was swept into the item and
    // destroyed by undo; with settle-time finalize it must survive both ways.
    store.commit('addRef', { path: '/ref/later.png' });

    undo();
    expect(store.state.referenceImages).toEqual([{ path: '/ref/later.png' }]);
    redo();
    expect(store.state.referenceImages).toEqual([{ path: '/ref/later.png' }]);
  });

  it('an OVERLAPPING later array write reverts with the slice (old-model parity, deterministic)', async () => {
    const store = makeStore();
    await store.dispatch(COLORIZE, { id: 'imgS', hex: '#123' });
    store.commit('addColor', { hex: '#later' });

    // Positional array patches restore the palette to its pre-colorize state —
    // the same wholesale-revert the old replaceState model performed. The item
    // itself stays clean: redo replays ONLY the colorize.
    undo();
    expect(store.state.colorPalette).toEqual([]);
    redo();
    expect(store.state.colorPalette.map((c) => c.hex)).toEqual(['#123']);
  });
});
