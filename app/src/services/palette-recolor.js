/**
 * palette-recolor — the pure planning core of the palette recolour pipeline.
 *
 * URI_CHANGE_COLOR is a heavy, I/O-bound Vuex action: it reads frame/image
 * store getters, decodes every affected frame onto a canvas, rewrites pixels,
 * re-encodes to a data URI, commits the results and mutates progress state in a
 * strict order. All of that MUST stay in the action — extracting it would pull
 * in canvas/DOM, image loading and Vuex, or reorder store mutations.
 *
 * Tangled inside that action, though, were two genuinely pure DECISIONS:
 *   - normalising a palette entry's legacy null fields to sane defaults, and
 *   - diffing old vs new palette state into the old->new uint32 swatch table
 *     that drives the per-pixel replacement.
 *
 * Those live here, free of canvas/Vuex/DOM, and are locked down by golden
 * tests. The uint32 packing is delegated to the existing (pure, byte-order-
 * defining) color-util helpers rather than reimplemented.
 *
 * This is a BEHAVIOUR-PRESERVING extraction. Two things are reproduced on
 * purpose (see report):
 *   - normalisePaletteEntry MUTATES the entry in place, because the action
 *     later reads the normalised newHex/newOpacity/newVisible off the very same
 *     palette objects when it resets the palette. Callers depend on the side
 *     effect, so it is kept.
 *   - the null checks use `=== null` (not `== null`), so an *undefined* legacy
 *     field is left untouched — exactly as the original `if (x === null)`
 *     guards behaved.
 */
import { hexToRgbArray, rgbaArrayToUint32, rgbaArrayToHex } from '@/util/color-util';
import { uniqueDrawings } from '@/services/xsheet';

/**
 * Pull the palette-rgba array out of a server response, tolerant of the several
 * shapes the handlers use. Mirrors POPULATE_PALETTE's fallback chain exactly
 * (ref_palette_rgba -> target_palette_rgba -> palette_rgba -> palette ->
 * colors_rgba -> []). Returns [] for a falsy/unknown response.
 *
 * @param {object} resp a server response object
 * @returns {Array} the palette-rgba entries (possibly empty)
 */
export function extractPaletteRgba(resp) {
  const arr = (resp && (
    resp.ref_palette_rgba
    || resp.target_palette_rgba
    || resp.palette_rgba
    || resp.palette
    || resp.colors_rgba
  )) || [];
  return Array.isArray(arr) ? arr : [];
}

/**
 * The dedupe/merge core of POPULATE_PALETTE, extracted pure. Given the current
 * palette and a palette-rgba array (from `extractPaletteRgba` or, in the
 * colorize run, the /preprocess `palette_rgba` directly), return the list of NEW
 * swatch objects to append — those whose hex is not already present.
 *
 * Semantics reproduced from the action, exactly:
 *  - each entry may be `[r,g,b,a]` or `{ r,g,b,a }` (a defaults to 255);
 *  - a fully transparent entry (a === 0) is skipped;
 *  - the hex is `rgbaArrayToHex(rgba).slice(0, -2)` (alpha nibble dropped);
 *  - dedupe is by hex against the existing palette AND within this response
 *    (the action re-reads the live, growing palette array between adds, so a
 *    colour repeated in one response is only added once).
 *
 * Pure: returns additions; the caller commits ADD_COLOR_TO_PALETTE for each.
 *
 * @param {object[]} existingPalette the current colorPalette (read-only here)
 * @param {Array} respPaletteRgba the palette-rgba entries to merge
 * @returns {object[]} new swatch objects to add (empty when nothing is new)
 */
export function mergePaletteRgba(existingPalette, respPaletteRgba) {
  const additions = [];
  if (!Array.isArray(respPaletteRgba) || respPaletteRgba.length === 0) {
    return additions;
  }
  const seenHexes = new Set((existingPalette || []).map((c) => c.hex));
  for (let z = 0; z < respPaletteRgba.length; z += 1) {
    const entry = respPaletteRgba[z];
    const rgba = Array.isArray(entry)
      ? entry
      : [entry.r, entry.g, entry.b, typeof entry.a === 'number' ? entry.a : 255];
    // Skip fully-transparent entries; the hex drops the alpha nibble.
    const hex = rgba[3] === 0 ? null : rgbaArrayToHex(rgba).slice(0, -2);
    if (hex && !seenHexes.has(hex)) {
      seenHexes.add(hex);
      additions.push({
        hex,
        newHex: hex,
        visible: true,
        newVisible: true,
        selected: false,
        firstSelected: false,
        opacity: 255,
        newOpacity: 255,
      });
    }
  }
  return additions;
}

/**
 * Derive the ordered, deduplicated set of color images a recolour pass must
 * rewrite — the READ side of URI_CHANGE_COLOR, replacing its old
 * `imageIdsToChange` accumulator walk (a mid-mutation `imageDataId ===` linear
 * scan). The unique-drawing answer comes from `xsheet.uniqueDrawings`, the one
 * home for drawing-identity (bug factory F3).
 *
 * Behaviour reproduced from the action, exactly:
 *  - the selected frame's color image is processed FIRST (the `seed`), and its
 *    id can be the LINKED line image's id when the color cel is ghost/deleted
 *    (the COLOR_IMAGE_*_FOR_SELECTED_FRAME getters' line fallback) — the caller
 *    resolves `seed` through those getters and passes it in;
 *  - the seed is included only when its data URI is truthy;
 *  - in all-frames mode the color layer is then scanned across `frameNrs` in
 *    ascending order; each UNIQUE color image (first occurrence wins) is added
 *    once, and only when its data URI is non-null (ghost/blank color cels, whose
 *    URI is null, are skipped);
 *  - the seed's id is never added twice.
 *
 * Pure: `uriById` resolves an image id to its data URI (or null). Returns the
 * ordered `[{ imageDataId, dataUri }]` the action feeds to the per-frame canvas
 * rewrite + `recolorPalette` command.
 *
 * @param {Object}   p
 * @param {Object}   p.layers        the state.layers dict
 * @param {string}   p.colorLayerId  the color layer id
 * @param {number[]} p.frameNrs      ascending frame numbers to scan (empty in
 *                                    preview mode, where only the seed is used)
 * @param {?{imageDataId: string, dataUri: (string|null)}} p.seed the selected
 *                                    frame's resolved color image (or null)
 * @param {(id: string) => (string|null)} p.uriById
 * @returns {Array<{imageDataId: string, dataUri: string}>}
 */
export function planRecolorTargets({
  layers, colorLayerId, frameNrs, seed, uriById,
}) {
  const targets = [];
  const seen = new Set();

  if (seed && seed.dataUri) {
    targets.push({ imageDataId: seed.imageDataId, dataUri: seed.dataUri });
    seen.add(seed.imageDataId);
  }

  const unique = uniqueDrawings(layers, colorLayerId, frameNrs || []);
  unique.forEach((_frameNrs, imageDataId) => {
    if (seen.has(imageDataId)) { return; }
    const dataUri = uriById(imageDataId);
    if (dataUri !== null) {
      targets.push({ imageDataId, dataUri });
      seen.add(imageDataId);
    }
  });

  return targets;
}

/**
 * Fill in the legacy-null defaults for a single palette entry, MUTATING it in
 * place and returning it. Mirrors the action's five guards, in order:
 *   - newHex     null -> hex
 *   - visible    null -> true
 *   - opacity    null -> 255
 *   - newOpacity null -> opacity (post-default)
 *   - newVisible null -> visible (post-default)
 *
 * The order matters: newOpacity falls back to the already-defaulted opacity,
 * and newVisible to the already-defaulted visible. Only strict `null` triggers
 * a default; `undefined` is left as-is (preserved from the original).
 *
 * @param {object} entry a palette swatch object (mutated in place)
 * @returns {object} the same entry
 */
export function normalisePaletteEntry(entry) {
  if (entry.newHex === null) { entry.newHex = entry.hex; }
  if (entry.visible === null) { entry.visible = true; }
  if (entry.opacity === null) { entry.opacity = 255; }
  if (entry.newOpacity === null) { entry.newOpacity = entry.opacity; }
  if (entry.newVisible === null) { entry.newVisible = entry.visible; }
  return entry;
}

/**
 * Whether a normalised palette entry participates in this recolour pass.
 * In preview mode (allFrames === false) only entries the user has `selected`
 * take part; when committing all frames, every entry is a candidate.
 *
 * @param {object} entry   a normalised palette swatch
 * @param {boolean} allFrames  true when committing all frames, false in preview
 * @returns {boolean}
 */
export function paletteEntryParticipates(entry, allFrames) {
  return allFrames || !!entry.selected;
}

/**
 * Whether a normalised palette entry actually changed (hex, opacity or
 * visibility differs from its new-* counterpart).
 *
 * @param {object} entry a normalised palette swatch
 * @returns {boolean}
 */
export function paletteEntryChanged(entry) {
  return entry.hex !== entry.newHex
    || entry.opacity !== entry.newOpacity
    || entry.visible !== entry.newVisible;
}

/**
 * Resolve the effective new opacity for a changed entry: an entry turned
 * invisible (newVisible === false) is remapped to opacity 0 regardless of its
 * stored newOpacity, matching the action.
 *
 * @param {object} entry a normalised palette swatch
 * @returns {number}
 */
export function resolveNewOpacity(entry) {
  if (!entry.newVisible) { return 0; }
  return entry.newOpacity;
}

/**
 * Build the old->new uint32 swatch mapping for one changed entry.
 *   - oldColor packs entry.hex   + entry.opacity
 *   - newColor packs entry.newHex + resolveNewOpacity(entry)
 * via hexToRgbArray -> [r,g,b,a] -> rgbaArrayToUint32 (the byte order lives in
 * those helpers).
 *
 * @param {object} entry a normalised, changed palette swatch
 * @returns {{uInt32: number, newUint32: number}}
 */
export function buildSwatchMapping(entry) {
  const newOpacity = resolveNewOpacity(entry);
  const currentRGBA = hexToRgbArray(entry.hex);
  const newRGBA = hexToRgbArray(entry.newHex);
  currentRGBA.push(entry.opacity);
  newRGBA.push(newOpacity);
  return {
    uInt32: rgbaArrayToUint32(currentRGBA), // .hex + .opacity as uint
    newUint32: rgbaArrayToUint32(newRGBA), // .newHex + .newOpacity as uint
  };
}

/**
 * Plan a palette recolour: normalise every entry (in place) and produce the
 * ordered list of old->new uint32 swatch mappings for the entries that both
 * participate and changed. This is exactly the loop the action ran to build
 * `swatchesToChange`, minus the console logging.
 *
 * NOTE: entries are normalised in place for ALL entries (the action normalises
 * before the participate/changed filter), so callers that later read the
 * normalised new-* fields off the palette still see them.
 *
 * @param {object[]} colorPalette the (mutable) palette array
 * @param {boolean} allFrames     true when committing all frames
 * @returns {Array<{uInt32: number, newUint32: number}>} the swatch table
 */
export function planPaletteRecolor(colorPalette, allFrames) {
  const swatchesToChange = [];
  for (let i = 0; i < colorPalette.length; i += 1) {
    const entry = colorPalette[i];
    normalisePaletteEntry(entry);
    if (paletteEntryParticipates(entry, allFrames) && paletteEntryChanged(entry)) {
      swatchesToChange.push(buildSwatchMapping(entry));
    }
  }
  return swatchesToChange;
}
