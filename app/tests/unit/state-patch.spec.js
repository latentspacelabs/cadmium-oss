// Golden tests for the pure diff/patch engine that backs Phase 6a undo/redo.
// They lock the op shapes and, most importantly, the roundtrip property:
// applyPatch is an exact inverse pair, so undo/redo can never drift. Array
// handling is index-wise with `undefined` holes (matching DELETE_SELECTED_FRAMES)
// and a setLength op for genuine shrink/grow (colorPalette/referenceImages).
import { cloneDeep } from 'lodash';
import { diff, applyPatch } from '@/services/state-patch';

// Convenience: run diff over every top-level key of `before`/`after`.
const scopeOf = (...objs) => {
  const keys = new Set();
  objs.forEach(o => Object.keys(o || {}).forEach(k => keys.add(k)));
  return Array.from(keys);
};
const fullDiff = (a, b) => diff(a, b, scopeOf(a, b));

// Apply a patch to a fresh clone so fixtures aren't mutated between assertions.
const applyTo = (state, patch) => {
  const next = cloneDeep(state);
  applyPatch(next, patch);
  return next;
};

describe('diff — empty', () => {
  it('identical objects -> null patches', () => {
    const a = { x: 1, y: { z: [1, 2, 3] } };
    const b = cloneDeep(a);
    expect(diff(a, b, scopeOf(a, b))).toEqual({ undoPatch: null, redoPatch: null });
  });

  it('changes outside the scope keys are ignored -> null', () => {
    const a = { doc: 1, ephemeral: 'a' };
    const b = { doc: 1, ephemeral: 'b' };
    expect(diff(a, b, ['doc'])).toEqual({ undoPatch: null, redoPatch: null });
  });
});

describe('diff — primitive set', () => {
  it('emits inverse set ops for a changed leaf', () => {
    const a = { n: 1 };
    const b = { n: 2 };
    const { undoPatch, redoPatch } = fullDiff(a, b);
    expect(redoPatch).toEqual([{ op: 'set', path: ['n'], value: 2 }]);
    expect(undoPatch).toEqual([{ op: 'set', path: ['n'], value: 1 }]);
  });

  it('diffs into nested objects to the changed leaf only', () => {
    const a = { p: { q: { r: 'old', keep: 1 } } };
    const b = { p: { q: { r: 'new', keep: 1 } } };
    const { redoPatch } = fullDiff(a, b);
    expect(redoPatch).toEqual([{ op: 'set', path: ['p', 'q', 'r'], value: 'new' }]);
  });
});

describe('diff — object key add / delete', () => {
  it('added key -> redo set / undo delete', () => {
    const a = { m: {} };
    const b = { m: { k: 9 } };
    const { undoPatch, redoPatch } = fullDiff(a, b);
    expect(redoPatch).toEqual([{ op: 'set', path: ['m', 'k'], value: 9 }]);
    expect(undoPatch).toEqual([{ op: 'delete', path: ['m', 'k'] }]);
  });

  it('removed key -> redo delete / undo set', () => {
    const a = { m: { k: 9 } };
    const b = { m: {} };
    const { undoPatch, redoPatch } = fullDiff(a, b);
    expect(redoPatch).toEqual([{ op: 'delete', path: ['m', 'k'] }]);
    expect(undoPatch).toEqual([{ op: 'set', path: ['m', 'k'], value: 9 }]);
  });
});

describe('diff — dict (imageDataById-like) add / remove / replace', () => {
  const dict = entries => ({ ImageStore: { imageDataById: entries } });

  it('add entry', () => {
    const a = dict({ id1: { dataUri: 'a', hash: 'h1' } });
    const b = dict({ id1: { dataUri: 'a', hash: 'h1' }, id2: { dataUri: 'b', hash: 'h2' } });
    expect(applyTo(a, fullDiff(a, b).redoPatch)).toEqual(b);
    expect(applyTo(b, fullDiff(a, b).undoPatch)).toEqual(a);
  });

  it('remove entry', () => {
    const a = dict({ id1: { dataUri: 'a' }, id2: { dataUri: 'b' } });
    const b = dict({ id1: { dataUri: 'a' } });
    expect(applyTo(a, fullDiff(a, b).redoPatch)).toEqual(b);
    expect(applyTo(b, fullDiff(a, b).undoPatch)).toEqual(a);
  });

  it('replace one field in place (dataUri edit)', () => {
    const a = dict({ id1: { dataUri: 'old', hash: 'h', segmentationMapPath: '/p' } });
    const b = dict({ id1: { dataUri: 'new', hash: 'h', segmentationMapPath: '/p' } });
    const { redoPatch } = fullDiff(a, b);
    // minimal: only the dataUri leaf, not the whole entry
    expect(redoPatch).toEqual([
      { op: 'set', path: ['ImageStore', 'imageDataById', 'id1', 'dataUri'], value: 'new' },
    ]);
    expect(applyTo(a, redoPatch)).toEqual(b);
  });
});

describe('diff — arrays with holes (frames-like)', () => {
  // frames arrays are sparse; deletion sets an index to `undefined` (a hole),
  // never splices, so length is preserved.
  it('set a frame at a fresh index', () => {
    const a = { layers: { L: { frames: [null, { id: 1 }] } } };
    const b = { layers: { L: { frames: [null, { id: 1 }, { id: 2 }] } } };
    expect(applyTo(a, fullDiff(a, b).redoPatch)).toEqual(b);
    expect(applyTo(b, fullDiff(a, b).undoPatch)).toEqual(a);
  });

  it('delete-as-hole: index becomes undefined, length preserved', () => {
    const a = { frames: [{ id: 0 }, { id: 1 }, { id: 2 }] };
    const b = { frames: [{ id: 0 }, undefined, { id: 2 }] };
    const { redoPatch, undoPatch } = fullDiff(a, b);
    expect(redoPatch).toEqual([{ op: 'set', path: ['frames', 1], value: undefined }]);
    const redone = applyTo(a, redoPatch);
    expect(redone.frames.length).toBe(3);
    expect(redone.frames[1]).toBeUndefined();
    expect(applyTo(b, undoPatch)).toEqual(a);
  });

  it('edits a field on one frame only', () => {
    const a = { frames: [{ id: 0, sel: false }, { id: 1, sel: false }] };
    const b = { frames: [{ id: 0, sel: false }, { id: 1, sel: true }] };
    const { redoPatch } = fullDiff(a, b);
    expect(redoPatch).toEqual([{ op: 'set', path: ['frames', 1, 'sel'], value: true }]);
  });
});

describe('diff — arrays that shrink / grow (palette-like)', () => {
  it('shrink emits setLength and roundtrips', () => {
    const a = { colorPalette: [{ hex: '#1' }, { hex: '#2' }, { hex: '#3' }] };
    const b = { colorPalette: [{ hex: '#1' }, { hex: '#3' }] }; // spliced out #2
    const { undoPatch, redoPatch } = fullDiff(a, b);
    expect(redoPatch.some(op => op.op === 'setLength' && op.length === 2)).toBe(true);
    expect(applyTo(a, redoPatch)).toEqual(b);
    expect(applyTo(b, undoPatch)).toEqual(a);
  });

  it('grow emits setLength and roundtrips', () => {
    const a = { refs: ['x'] };
    const b = { refs: ['x', 'y', 'z'] };
    const { undoPatch, redoPatch } = fullDiff(a, b);
    expect(applyTo(a, redoPatch)).toEqual(b);
    expect(applyTo(b, undoPatch)).toEqual(a);
  });
});

describe('applyPatch — reactivity-friendly semantics', () => {
  it('creates missing intermediate containers for a deep set', () => {
    const state = { a: {} };
    applyPatch(state, [{ op: 'set', path: ['a', 'b', 'c'], value: 5 }]);
    expect(state.a.b.c).toBe(5);
  });

  it('null/empty patch is a no-op', () => {
    const state = { a: 1 };
    applyPatch(state, null);
    applyPatch(state, []);
    expect(state).toEqual({ a: 1 });
  });
});

describe('roundtrip property — apply then inverse returns to start', () => {
  const fixtures = [
    { a: { n: 1 }, b: { n: 2 } },
    { a: { p: { q: 1, r: 2 } }, b: { p: { q: 9 } } }, // key removed
    { a: { m: {} }, b: { m: { added: { deep: [1, 2] } } } },
    {
      a: { ImageStore: { imageDataById: { i1: { dataUri: 'a', hash: 'h', n: 1 } } } },
      b: { ImageStore: { imageDataById: { i1: { dataUri: 'b', hash: 'h', n: 1 }, i2: { dataUri: 'c' } } } },
    },
    {
      a: { layers: { L: { frames: [null, { id: 1, sel: false }, { id: 2 }] } } },
      b: { layers: { L: { frames: [null, { id: 1, sel: true }, undefined, { id: 3 }] } } },
    },
    { a: { colorPalette: [1, 2, 3, 4] }, b: { colorPalette: [1, 9] } },
    { a: { x: 'gone' }, b: {} },
  ];

  fixtures.forEach(({ a, b }, i) => {
    it(`fixture ${i}: redoPatch(a) === b and undoPatch(b) === a`, () => {
      const { undoPatch, redoPatch } = fullDiff(a, b);
      // redo takes a -> b
      expect(applyTo(a, redoPatch)).toEqual(b);
      // undo takes b -> a
      expect(applyTo(b, undoPatch)).toEqual(a);
    });

    it(`fixture ${i}: undo∘redo from a returns to b (round trip)`, () => {
      const { undoPatch, redoPatch } = fullDiff(a, b);
      const atB = applyTo(a, redoPatch);
      const backToA = applyTo(atB, undoPatch);
      expect(backToA).toEqual(a);
      const redoAgain = applyTo(backToA, redoPatch);
      expect(redoAgain).toEqual(b);
    });
  });
});
