/**
 * COLOR_IMAGE(_ID)_FOR_SELECTED_FRAME must never fall back to the LINE frame.
 *
 * The removed "fallback to line frame for display" was dormant while ghost
 * color records exist (a ghost's truthy id short-circuits the first branch),
 * but armed: any id-less color frame would have handed paint/fill the line
 * art as base and the line frame's id as the WRITE target — flood fill and
 * freehand would then overwrite the line drawing in place.
 */
import getters from '@/store/getters';
import {
  COLOR_IMAGE_FOR_SELECTED_FRAME,
  COLOR_IMAGE_ID_FOR_SELECTED_FRAME,
} from '@/store/getter-types';

function makeState({ colorFrame, lineFrame }) {
  return {
    selectedFrame: 1,
    layers: {
      lineLayer1: { frames: [null, lineFrame || null] },
      colorLayer1: { frames: [null, colorFrame || null] },
    },
    ImageStore: {
      imageDataById: {
        L1: { dataUri: 'data:image/png;base64,LINE' },
        C1: { dataUri: 'data:image/png;base64,COLOR' },
        L1_color: { dataUri: null, hash: null }, // ghost
      },
    },
  };
}

describe('COLOR_IMAGE(_ID)_FOR_SELECTED_FRAME — no line fallback', () => {
  it('returns the color image/id when the color frame has one', () => {
    const state = makeState({
      colorFrame: { frameNr: 1, imageDataId: 'C1' },
      lineFrame: { frameNr: 1, imageDataId: 'L1' },
    });
    expect(getters[COLOR_IMAGE_ID_FOR_SELECTED_FRAME](state)).toBe('C1');
    expect(getters[COLOR_IMAGE_FOR_SELECTED_FRAME](state)).toBe('data:image/png;base64,COLOR');
  });

  it('a ghost color record yields the ghost id but a null uri (paint converts the ghost)', () => {
    const state = makeState({
      colorFrame: { frameNr: 1, imageDataId: 'L1_color' },
      lineFrame: { frameNr: 1, imageDataId: 'L1' },
    });
    expect(getters[COLOR_IMAGE_ID_FOR_SELECTED_FRAME](state)).toBe('L1_color');
    expect(getters[COLOR_IMAGE_FOR_SELECTED_FRAME](state)).toBeNull();
  });

  it('an id-less color frame returns null for BOTH — never the line frame (the landmine)', () => {
    const state = makeState({
      colorFrame: { frameNr: 1, imageDataId: null },
      lineFrame: { frameNr: 1, imageDataId: 'L1' },
    });
    expect(getters[COLOR_IMAGE_ID_FOR_SELECTED_FRAME](state)).toBeNull();
    expect(getters[COLOR_IMAGE_FOR_SELECTED_FRAME](state)).toBeNull();
  });

  it('a missing color frame returns null for both even when line art exists', () => {
    const state = makeState({
      colorFrame: null,
      lineFrame: { frameNr: 1, imageDataId: 'L1' },
    });
    expect(getters[COLOR_IMAGE_ID_FOR_SELECTED_FRAME](state)).toBeNull();
    expect(getters[COLOR_IMAGE_FOR_SELECTED_FRAME](state)).toBeNull();
  });
});
