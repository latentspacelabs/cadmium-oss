/**
 * export-frame — the pure per-frame decisions of the export pipeline.
 *
 * Two things lived tangled inside EXPORT_FILES (actions.js) that are actually
 * pure and bug-prone, so they live here behind golden tests:
 *
 *  1. `paletteFilter` — the per-color pixel loop that, when exporting colors
 *     separately, keeps only the pixels matching one palette swatch and zeroes
 *     the rest (actions.js:1544-1603).
 *  2. `composeFramePlan` — the interleaved `if`s that decided which layers
 *     (background / color / line / blank) get drawn for a frame, in what order.
 *
 * Both are free of Vuex/Electron/fs/canvas so `runExport` can be unit-tested
 * headless and the semantics (including the quirks below) are locked down.
 */

import { hexToRgbArray, rgbaArrayToUint32 } from '@/util/color-util';

/**
 * In-place per-color filter for a colors-separated export pass. Exact port of
 * the pixel loop at actions.js:1544-1603.
 *
 * Given decoded RGBA pixels and one palette entry, every pixel whose colour
 * does NOT match the entry (alpha ignored) is zeroed to fully transparent; a
 * matching pixel is either zeroed (when the entry is hidden or fully
 * transparent) or kept with its alpha replaced by the entry's opacity.
 *
 * LITTLE-ENDIAN ASSUMPTION (inherited, documented, unchanged): the loop reads
 * the RGBA byte buffer through a `Uint32Array`, so an on-screen pixel
 * [R,G,B,A] is read as the word 0xAABBGGRR. `rgbaArrayToUint32([r,g,b,a])`
 * likewise packs to 0xAABBGGRR, and both sides then drop the top (alpha) byte
 * via `% 2**24`, so the compare is (B,G,R)-vs-(B,G,R). This is only correct on
 * a little-endian host (every platform Cadmium ships on). On a big-endian host
 * the word layout would be reversed and the match would break — same as the
 * original code.
 *
 * QUIRKS locked by tests:
 *  - `newVisible`/`newOpacity` (the pending, un-applied palette edits) take
 *    precedence over `visible`/`opacity` when defined.
 *  - a pixel that MATCHES the target colour but whose entry is `visible:false`
 *    (or opacity 0) is zeroed, not kept.
 *  - a non-matching pixel is always zeroed, regardless of its own alpha.
 *  - `opacity` defaults to 255 when the entry has none.
 *
 * @param {{ width:number, height:number, data:Uint8ClampedArray }} imageData
 *   mutated in place (via a Uint32Array view over `data.buffer`).
 * @param {Object} paletteEntry - a colorPalette swatch
 *   ({ hex, opacity?, visible?, newVisible?, newOpacity? }).
 * @returns {{ width:number, height:number, data:Uint8ClampedArray }} imageData
 */
export function paletteFilter(imageData, paletteEntry) {
  if (!paletteEntry) { return imageData; }
  const data32 = new Uint32Array(imageData.data.buffer);

  const targetRGBA = hexToRgbArray(paletteEntry.hex);
  targetRGBA.push(paletteEntry.opacity != null ? paletteEntry.opacity : 255);
  const targetUint32 = rgbaArrayToUint32(targetRGBA);
  const targetNoAlpha = targetUint32 % (2 ** 24);
  const visible = (paletteEntry.newVisible !== undefined)
    ? paletteEntry.newVisible : paletteEntry.visible;
  const baseOpacity = paletteEntry.opacity != null ? paletteEntry.opacity : 255;
  const opacity = paletteEntry.newOpacity !== undefined ? paletteEntry.newOpacity : baseOpacity;

  let idx = data32.length - 1;
  while (idx >= 0) {
    const pix = data32[idx];
    const pixNoAlpha = pix % (2 ** 24);
    if (pixNoAlpha !== targetNoAlpha) {
      data32[idx] = 0; // fully transparent for non-target colours
    } else if (!visible || opacity === 0) {
      data32[idx] = 0;
    } else {
      // keep RGB, set alpha to the palette opacity
      data32[idx] = pixNoAlpha + (opacity * (2 ** 24));
    }
    idx -= 1;
  }

  return imageData;
}

/**
 * The ordered list of layers to composite for a single frame — the pure
 * decision that was spread across the interleaved `if`s in EXPORT_FILES.
 *
 * Rules (behaviour-preserving):
 *  - background first, when `layersVisible.background` (mp4 flattens onto a
 *    solid colour; png/svg keep alpha and have no background layer);
 *  - color when `(layersVisible.color || colors-separated pass) && hasColor` —
 *    the QUIRK is that a colors-separated pass IGNORES color-layer visibility
 *    (actions.js:1538/1561: `exportEachColorIndex !== null || colorLayer.visible`);
 *  - line when `layersVisible.line && hasLine && NOT a colors-separated pass`
 *    (separated output is colour-only);
 *  - blank fallback when nothing else was added (a missing frame inside a
 *    sequence still writes a transparent frame so the sequence isn't broken).
 *
 * A pass is "colors-separated" iff `pass.index` is a number (the palette index
 * to filter to); a flat pass has `index === null`.
 *
 * @param {Object} args
 * @param {boolean} args.hasColor - a colour drawing is present for the frame.
 * @param {boolean} args.hasLine - a line drawing is present for the frame.
 * @param {{ index:(number|null) }} args.pass
 * @param {{ line:boolean, color:boolean, background:boolean }} args.layersVisible
 * @returns {Array<{ kind:('background'|'color'|'line'|'blank'), filterIndex?:(number|null) }>}
 */
export function composeFramePlan({
  hasColor, hasLine, pass, layersVisible,
}) {
  const separated = pass && pass.index !== null && pass.index !== undefined;
  const layers = [];

  if (layersVisible.background) {
    layers.push({ kind: 'background' });
  }
  if ((layersVisible.color || separated) && hasColor) {
    layers.push({ kind: 'color', filterIndex: separated ? pass.index : null });
  }
  if (layersVisible.line && hasLine && !separated) {
    layers.push({ kind: 'line' });
  }
  if (layers.length === 0) {
    layers.push({ kind: 'blank' });
  }

  return layers;
}
