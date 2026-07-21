// Unit tests for the DocumentService command layer (document.js). Each command
// is asserted against a recording store — the exact mutation/dispatch SEQUENCE
// it must run — so the extraction is provably behaviour-preserving against the
// call sites it replaced (ADD_IMAGES_TO_TIMELINE, colorize-run, POPULATE_PALETTE,
// URI_CHANGE_COLOR). The exposeLineDrawing test also LOCKS the phase-6b ghost
// decision: the `<lineId>_color` blank record is KEPT (dropping it activates a
// line-fallback getter that would overwrite line art — see the command's note).
import {
  exposeLineDrawing,
  attachColorToCel,
  mergePalette,
  recolorPalette,
  LINE_LAYER_ID,
  COLOR_LAYER_ID,
} from '@/services/document';
import {
  SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
  CREATE_EMPTY_FRAME_IF_NONE_EXISTS,
  ADD_COLOR_TO_PALETTE,
  REPLACE_IMAGE_DATA_URI,
  SET_CANVAS_REDRAW_TRIGGER,
} from '@/store/mutation-types';
import { STORE_BLANK_IMAGE_IN_IMAGE_STORE } from '@/store/action-types';
import { COLOR_PALETTE } from '@/store/getter-types';

// A recording store: commits + dispatches logged in one ordered trace so the
// command's mutation/dispatch SEQUENCE (not just the set of calls) is asserted.
// ADD_COLOR_TO_PALETTE pushes into the live palette so mergePalette's dedupe
// sees prior adds (idempotence), mirroring the real store.
function makeStore({ palette = [] } = {}) {
  const trace = [];
  const paletteArr = palette.slice();
  return {
    getters: { [COLOR_PALETTE]: paletteArr },
    commit: jest.fn((type, payload) => {
      trace.push({ kind: 'commit', type, payload });
      if (type === ADD_COLOR_TO_PALETTE) { paletteArr.push(payload); }
    }),
    dispatch: jest.fn((type, payload) => {
      trace.push({ kind: 'dispatch', type, payload });
    }),
    _trace: trace,
    _palette: paletteArr,
  };
}

describe('exposeLineDrawing', () => {
  it('sets the line image then creates the paired GHOST color cel (ghost kept)', () => {
    const store = makeStore();
    exposeLineDrawing(store, {
      frameNr: 3, imageDataId: 'L3', isOriginal: true, isLoading: false,
    });

    expect(store._trace).toEqual([
      {
        kind: 'commit',
        type: SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
        payload: {
          imageDataId: 'L3',
          frameNr: 3,
          layerId: LINE_LAYER_ID,
          isOriginal: true,
          isLoading: false,
        },
      },
      // GHOST DECISION: a blank `<lineId>_color` image is stored ...
      {
        kind: 'dispatch',
        type: STORE_BLANK_IMAGE_IN_IMAGE_STORE,
        payload: { imageDataId: 'L3_color' },
      },
      // ... and the color cel carries that ghost id (NOT id-less).
      {
        kind: 'commit',
        type: CREATE_EMPTY_FRAME_IF_NONE_EXISTS,
        payload: { frameNr: 3, layerId: COLOR_LAYER_ID, imageDataId: 'L3_color' },
      },
    ]);
  });

  it('defaults isOriginal/isLoading to false', () => {
    const store = makeStore();
    exposeLineDrawing(store, { frameNr: 1, imageDataId: 'L1' });
    const set = store._trace[0];
    expect(set.payload.isOriginal).toBe(false);
    expect(set.payload.isLoading).toBe(false);
  });
});

describe('attachColorToCel', () => {
  it('commits one SET on the color layer with the given flags', () => {
    const store = makeStore();
    attachColorToCel(store, { frameNr: 5, imageDataId: 'C5', isOriginal: false });
    expect(store._trace).toEqual([
      {
        kind: 'commit',
        type: SET_IMAGE_DATA_FOR_FRAME_WITH_ID,
        payload: {
          layerId: COLOR_LAYER_ID,
          imageDataId: 'C5',
          frameNr: 5,
          isOriginal: false,
          force: false,
        },
      },
    ]);
  });

  it('passes force through (rainbow / re-colorize overwrite)', () => {
    const store = makeStore();
    attachColorToCel(store, {
      frameNr: 2, imageDataId: 'C2', isOriginal: false, force: true,
    });
    expect(store._trace[0].payload.force).toBe(true);
  });
});

describe('mergePalette', () => {
  it('commits one ADD_COLOR_TO_PALETTE per genuinely-new swatch', () => {
    const store = makeStore();
    const added = mergePalette(store, [[255, 0, 0, 255], [0, 255, 0, 255]]);
    expect(added).toBe(2);
    const adds = store._trace.filter((t) => t.type === ADD_COLOR_TO_PALETTE);
    expect(adds.map((t) => t.payload.hex)).toEqual(['#ff0000', '#00ff00']);
  });

  it('is idempotent: re-merging the same swatches adds nothing', () => {
    const store = makeStore({ palette: [{ hex: '#ff0000' }] });
    const added = mergePalette(store, [[255, 0, 0, 255]]);
    expect(added).toBe(0);
    expect(store._trace).toEqual([]);
  });

  it('skips a fully-transparent entry', () => {
    const store = makeStore();
    expect(mergePalette(store, [[1, 2, 3, 0]])).toBe(0);
  });
});

describe('recolorPalette', () => {
  it('replaces the image data URI then triggers a redraw', () => {
    const store = makeStore();
    recolorPalette(store, { imageDataId: 'C7', dataUri: 'data:image/png;base64,NEW' });
    expect(store._trace).toEqual([
      {
        kind: 'commit',
        type: REPLACE_IMAGE_DATA_URI,
        payload: { imageDataId: 'C7', dataUri: 'data:image/png;base64,NEW' },
      },
      { kind: 'commit', type: SET_CANVAS_REDRAW_TRIGGER, payload: undefined },
    ]);
  });
});
