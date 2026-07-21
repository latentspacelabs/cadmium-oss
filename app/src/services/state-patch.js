/**
 * state-patch — a tiny structural diff/patch engine for undo/redo.
 *
 * Phase 6a replaces the old "clone (almost) the whole Vuex state and
 * replaceState it back" undo model (F5 in docs/architecture.md) with inverse
 * patches computed from a structural diff of a small, explicit set of
 * document slices. This module is the pure core: it knows nothing about Vuex,
 * the undoable actions, or which keys are in scope — it just diffs two plain
 * objects over a caller-supplied key list and applies the resulting ops.
 *
 * A PATCH is an array of ops. Each op is one of:
 *   { op: 'set',       path: [k0, k1, ...], value }  -> Vue.set(parent, last, value)
 *   { op: 'delete',    path: [k0, k1, ...] }         -> remove `last` from parent
 *   { op: 'setLength', path: [k0, k1, ...], length } -> parent-at-path is an
 *                                                       Array; fix its length
 *
 * `diff(a, b, scopeKeys)` returns `{ undoPatch, redoPatch }` where:
 *   - `redoPatch` transforms `a` into `b` (re-apply the change),
 *   - `undoPatch` transforms `b` into `a` (revert the change).
 * If nothing in scope changed, both are `null` (caller pushes no undo item).
 *
 * ARRAY handling (layers[*].frames, colorPalette, referenceImages, tempFilePaths):
 *   arrays are diffed element-wise BY INDEX. Deletions in this codebase set a
 *   frame slot to `undefined` via `Vue.set(frames, i, undefined)` (holes, not
 *   splices — see mutations.js DELETE_SELECTED_FRAMES), so an index whose value
 *   became `undefined` is emitted as `set(i, undefined)`, NOT `delete`, which
 *   preserves array length exactly the way the mutation does. When two arrays
 *   differ in length a `setLength` op is emitted so the roundtrip is exact even
 *   for arrays that genuinely shrink (colorPalette/referenceImages splice).
 *
 * DICT handling (ImageStore.imageDataById): a plain object keyed by id.
 *   added key   -> redo set / undo delete
 *   removed key -> redo delete / undo set
 *   changed key -> recurse (in-place field edits like `dataUri = ...` produce a
 *                  minimal leaf `set` on that field only).
 *
 * MEMORY: patch ops store *references* to the touched values while they sit on
 * the stacks — only entries that actually changed are retained, so a COLORIZE
 * that rewrites 12 color images keeps ~12 old + 12 new dataUri references
 * instead of a full clone of the entire ImageStore (the old model's cost,
 * times up to 5).
 *
 * ALIASING: `applyPatch` installs a deep CLONE of each set-op value, never the
 * stored object itself. Without the clone, applying an item's patch would make
 * live state and the item (now sitting on the opposite stack) share the same
 * objects, and any later in-place mutation from a non-undoable path (e.g.
 * ANALYZE_CURRENT_FRAME writing segmentationMapPath, HYDRATE_IMAGE_DATA_URI)
 * would silently corrupt the stored patch. Immutable strings (the multi-MB
 * dataUris) are shared by the clone, so this costs only the small containers.
 */

import Vue from 'vue';
import { cloneDeep } from 'lodash';

function kindOf(v) {
  if (Array.isArray(v)) { return 'array'; }
  if (v !== null && typeof v === 'object') { return 'object'; }
  return 'leaf';
}

// Treat two NaNs as equal so numeric leaves don't diff forever; everything else
// uses strict `===` (reference equality for objects is handled by the callers).
function leafEqual(a, b) {
  if (a === b) { return true; }
  return typeof a === 'number' && typeof b === 'number'
    && Number.isNaN(a) && Number.isNaN(b);
}

function diffValue(a, b, path, undoOps, redoOps) {
  if (a === b) { return; }
  const ka = kindOf(a);
  const kb = kindOf(b);

  if (ka === 'array' && kb === 'array') {
    diffArray(a, b, path, undoOps, redoOps);
    return;
  }
  if (ka === 'object' && kb === 'object') {
    diffObject(a, b, path, undoOps, redoOps);
    return;
  }
  // Leaf change, or a shape change (object<->leaf, array<->object, ...): the
  // whole value at this path is replaced. `b` may be `undefined` (array hole).
  if (leafEqual(a, b)) { return; }
  redoOps.push({ op: 'set', path, value: b });
  undoOps.push({ op: 'set', path, value: a });
}

function diffArray(a, b, path, undoOps, redoOps) {
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    diffValue(a[i], b[i], path.concat(i), undoOps, redoOps);
  }
  if (a.length !== b.length) {
    redoOps.push({ op: 'setLength', path, length: b.length });
    undoOps.push({ op: 'setLength', path, length: a.length });
  }
}

function diffObject(a, b, path, undoOps, redoOps) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  for (let i = 0; i < keysA.length; i += 1) {
    const key = keysA[i];
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      diffValue(a[key], b[key], path.concat(key), undoOps, redoOps);
    } else {
      // present in a, gone in b
      redoOps.push({ op: 'delete', path: path.concat(key) });
      undoOps.push({ op: 'set', path: path.concat(key), value: a[key] });
    }
  }
  for (let i = 0; i < keysB.length; i += 1) {
    const key = keysB[i];
    if (!Object.prototype.hasOwnProperty.call(a, key)) {
      // new in b
      redoOps.push({ op: 'set', path: path.concat(key), value: b[key] });
      undoOps.push({ op: 'delete', path: path.concat(key) });
    }
  }
}

/**
 * Structurally diff two snapshots over an explicit key list.
 * @param {Object} a - "before" snapshot (plain object, e.g. from snapshotScope)
 * @param {Object} b - "after" snapshot
 * @param {string[]} scopeKeys - top-level keys to diff; anything else is ignored
 * @returns {{ undoPatch: Array|null, redoPatch: Array|null }}
 */
export function diff(a, b, scopeKeys) {
  const undoOps = [];
  const redoOps = [];
  for (let i = 0; i < scopeKeys.length; i += 1) {
    const key = scopeKeys[i];
    diffValue(
      a ? a[key] : undefined,
      b ? b[key] : undefined,
      [key],
      undoOps,
      redoOps,
    );
  }
  if (redoOps.length === 0) {
    return { undoPatch: null, redoPatch: null };
  }
  return { undoPatch: undoOps, redoPatch: redoOps };
}

// Walk to the container that holds the final path segment. When `create` is
// true (used for `set`), missing intermediate containers are created reactively
// so a brand-new nested path can be written.
function containerAt(root, path, create) {
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (node[key] === null || typeof node[key] !== 'object') {
      if (!create) { return null; }
      const nextKey = path[i + 1];
      Vue.set(node, key, typeof nextKey === 'number' ? [] : {});
    }
    node = node[key];
  }
  return node;
}

/**
 * Apply a patch to a (reactive) target object in place. Uses Vue.set/Vue.delete
 * so Vuex reactivity holds — there is no replaceState. Applying `redoPatch`
 * after `undoPatch` (or vice-versa) is an exact inverse for any snapshot pair
 * produced by `diff`.
 * @param {Object} target - the object to mutate (e.g. the Vuex root state)
 * @param {Array} patch - ops from diff(); a `null`/empty patch is a no-op
 */
export function applyPatch(target, patch) {
  if (!patch || patch.length === 0) { return; }
  for (let i = 0; i < patch.length; i += 1) {
    const op = patch[i];
    if (op.op === 'setLength') {
      // op.path points at the array itself; walk to its parent and fix length.
      const arrParent = containerAt(target, op.path, false);
      const arrKey = op.path[op.path.length - 1];
      const theArray = arrParent ? arrParent[arrKey] : undefined;
      if (Array.isArray(theArray)) {
        if (theArray.length > op.length) {
          theArray.splice(op.length); // reactive truncate
        } else if (theArray.length < op.length) {
          theArray.length = op.length; // pad with trailing holes
        }
      }
      continue;
    }
    const parent = containerAt(target, op.path, op.op === 'set');
    if (!parent) { continue; }
    const lastKey = op.path[op.path.length - 1];
    if (op.op === 'set') {
      // Clone so live state never aliases the stored patch (see header).
      Vue.set(parent, lastKey, cloneDeep(op.value));
    } else if (op.op === 'delete') {
      if (Array.isArray(parent)) {
        // Match DELETE_SELECTED_FRAMES: null the slot, preserve length.
        Vue.set(parent, lastKey, undefined);
      } else {
        Vue.delete(parent, lastKey);
      }
    }
  }
}
