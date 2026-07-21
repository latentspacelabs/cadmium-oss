/**
 * export-plan — the pure planning core of the export pipeline.
 *
 * The EXPORT actions are heavy on orchestration (native dialogs, canvas
 * compositing, fs writes, ffmpeg). Tangled inside that were a handful of pure
 * decisions — how to parse the chosen target path, which behaviours each format
 * implies, how per-color subfolders and per-frame filenames are numbered, the
 * SVG tracer presets, and the ffmpeg fps clamp. Those are the bug-prone bits
 * (the frame-number padding carries a frame-0 off-by-one), so they live here,
 * free of Vuex/Electron/fs/DOM, and are locked down by golden tests. The store
 * actions keep the dialogs and the actual I/O.
 */
import path from 'path';
import { leftPad } from '@/util/filename-util';
import { hexToRgbObject } from '@/util/color-util';
import { celAt } from '@/services/xsheet';
import {
  INITIAL_LINE_LAYER_ID,
  INITIAL_COLOR_LAYER_ID,
} from '@/store/general-types';
import {
  FRAME_COUNT,
  CANVAS_SIZE,
  BACKGROUND_COLOR,
  COLOR_PALETTE,
} from '@/store/getter-types';

export const EXPORT_FORMAT = {
  PNG: 'png',
  SVG: 'svg',
  MP4: 'mp4',
};

/**
 * Split the user's chosen file path into the pieces the export loop needs.
 * `filePathNoExtBase` strips the trailing 4-char extension (".png"/".svg"/
 * ".mp4"), matching the action's original slice(0, -4).
 */
export function parseExportTarget(fullFilePath) {
  const folder = path.dirname(fullFilePath);
  const fileNameOnly = path.basename(fullFilePath);
  const prefix = fileNameOnly.split('.')[0];
  const ext = fullFilePath.split('.').pop();
  const filePathNoExtBase = fullFilePath.slice(0, -4);
  return {
    folder, prefix, ext, filePathNoExtBase,
  };
}

/**
 * Per-extension export behaviour. svgQualityNum is gathered separately (it
 * comes from a dialog), so it is not decided here.
 * - svg/mp4 render to temp PNGs first; mp4 flattens onto a solid background.
 * - png writes straight through with its alpha channel.
 */
export function planExportFormat(ext) {
  switch (ext) {
    case EXPORT_FORMAT.SVG:
      return { requiresTmpExport: true, alphaChannel: true };
    case EXPORT_FORMAT.MP4:
      return { requiresTmpExport: true, alphaChannel: false };
    default: // png
      return { requiresTmpExport: false, alphaChannel: true };
  }
}

/**
 * Subfolder and path stem for the i-th color when exporting colors separately.
 * passIndex is 0-based; the on-disk color number is 1-based and zero-padded to
 * two digits (color01, color02, ...).
 */
export function colorPassPaths(folder, prefix, passIndex) {
  const colorNumber = 'color'.concat(leftPad(passIndex + 1, 2));
  const subFolder = path.join(folder, colorNumber);
  const filePathNoExt = path.join(subFolder, `${prefix}_${colorNumber}`);
  return {
    colorNumber,
    subFolder,
    filePathNoExt,
    filePathMp4: `${filePathNoExt}.mp4`,
  };
}

/**
 * Per-frame path stem (no extension) plus the padded frame number.
 * Mirrors the action's frame-0 hack: frames are 1-based with a frame-0
 * placeholder, so the exported number is frameNr - 1, zero-padded to
 * (digits of frameCount) - 1.
 */
export function frameExportStem(filePathNoExt, frameNr, frameCount) {
  const exportDigits = frameCount.toString().length - 1;
  const exportNr = frameNr - 1;
  const paddedFrameNr = leftPad(exportNr, exportDigits);
  return { paddedFrameNr, stem: `${filePathNoExt}_${paddedFrameNr}` };
}

/**
 * The inclusive frame range exported: every frame from the first to the last
 * real frame in the sequence.
 */
export function exportFrameRange(firstFrame, lastFrame) {
  const frames = [];
  for (let n = firstFrame; n <= lastFrame; n += 1) {
    frames.push(n);
  }
  return frames;
}

/**
 * ffmpeg fps clamp: an integer in [1, 60]. Junk input (non-finite, <= 0)
 * falls back to 24.
 */
export function normalizeExportFps(rawFps) {
  const n = Number(rawFps);
  const usable = Number.isFinite(n) && n > 0 ? Math.round(n) : 24;
  return Math.min(60, Math.max(1, usable));
}

/**
 * ImageTracer options for each SVG quality tier: 0 = high, 1 = medium,
 * 2 = low. (Tier 3 is the dialog's cancel and never reaches here.) `palette`
 * is the RGB palette passed straight through as ImageTracer's `pal`.
 */
export function svgTracerOptions(svgQualityNum, palette) {
  const base = {
    scale: 1,
    strokewidth: 0.5,
    colorsampling: 0,
    colorquantcycles: 1,
    pal: palette,
  };
  switch (svgQualityNum) {
    case 0: // high
      return {
        ...base,
        blurradius: 2,
        blurdelta: 3,
        ltres: 0.05,
        qtres: 0.05,
        rightangleenhance: false,
        pathomit: 4,
      };
    case 1: // medium
      return {
        ...base,
        blurradius: 1,
        blurdelta: 3,
        ltres: 1,
        qtres: 1,
        rightangleenhance: false,
        pathomit: 10,
        numberofcolors: 50,
      };
    case 2: // low
      return { ...base };
    default:
      return {};
  }
}

/**
 * The ImageTracer `pal` palette — exact port of MAKE_COLOR_PALETTE_RGB
 * (actions.js): each swatch's hex mapped to an { r, g, b, a:255 } object, plus a
 * trailing fully-transparent entry so the tracer has a colour for empty pixels.
 *
 * @param {Array<{ hex:string }>} palette - the colorPalette swatches.
 * @returns {Array<{ r:number, g:number, b:number, a:number }>}
 */
export function makeRgbPalette(palette) {
  const rgbPalette = (palette || []).map((entry) => hexToRgbObject(entry.hex));
  rgbPalette.push({
    r: 0, g: 0, b: 0, a: 0,
  });
  return rgbPalette;
}

/**
 * Extract the plain-data snapshot `planExport` needs from Vuex. Deterministic
 * given (state, getters) and free of side effects — the store boundary for the
 * export planner. The palette is deep-ish copied so a later mutation can't
 * change a plan already handed to the runner.
 *
 * @param {Object} state - the root Vuex state.
 * @param {Object} getters - the Vuex getters map.
 * @returns {Object} snapshot
 */
export function exportSnapshot(state, getters) {
  const lineLayer = state.layers[INITIAL_LINE_LAYER_ID];
  const colorLayer = state.layers[INITIAL_COLOR_LAYER_ID];
  return {
    firstRealFrameNumber: state.firstRealFrameNumber,
    lastRealFrameNumber: state.lastRealFrameNumber,
    frameCount: getters[FRAME_COUNT],
    palette: (getters[COLOR_PALETTE] || []).map((entry) => ({ ...entry })),
    layersVisible: {
      line: !!(lineLayer && lineLayer.visible),
      color: !!(colorLayer && colorLayer.visible),
    },
    canvasSize: getters[CANVAS_SIZE],
    backgroundColor: getters[BACKGROUND_COLOR],
    fps: state.playerFps,
    layers: state.layers,
  };
}

/**
 * Pure export plan: `(snapshot, { kind }) -> plan | { error }`. The typed errors
 * are surfaced BEFORE any dialog, killing the empty-palette silent no-op
 * (F1/F4) — colors-separated with an empty palette can no longer show a save
 * dialog and then write zero passes.
 *
 * Errors (in precedence order, reproducing the old guards):
 *  - NO_VISIBLE_LAYERS — neither line nor color layer visible (EXPORT_PRELOOP's
 *    "No Visible Layers" guard).
 *  - NO_FRAMES — the first..last real-frame range is empty (EXPORT_DIALOG's
 *    empty-array "No Frames to Export" guard).
 *  - EMPTY_PALETTE — colors-separated only, with a zero-length palette.
 *
 * On success returns inspectable data: per-frame cel ids (via xsheet `celAt`),
 * the pass list (flat = one `{ index:null }` pass; colors-separated = one pass
 * per palette swatch), and the render inputs (canvasSize, backgroundColor,
 * palette copy, layer visibility, fps). Per-pass on-disk paths are NOT decided
 * here (they need the post-dialog target) — see `resolveExportTarget`.
 *
 * @param {Object} snapshot - from `exportSnapshot`.
 * @param {Object} [opts]
 * @param {('flat'|'colors-separated')} [opts.kind='flat']
 * @returns {Object} plan or { error }
 */
export function planExport(snapshot, { kind = 'flat' } = {}) {
  const separated = kind === 'colors-separated';
  const { line, color } = snapshot.layersVisible;

  if (!line && !color) { return { error: 'NO_VISIBLE_LAYERS' }; }

  const frameNrs = exportFrameRange(
    snapshot.firstRealFrameNumber,
    snapshot.lastRealFrameNumber,
  );
  if (frameNrs.length === 0) { return { error: 'NO_FRAMES' }; }

  if (separated && snapshot.palette.length === 0) { return { error: 'EMPTY_PALETTE' }; }

  const frames = frameNrs.map((frameNr) => {
    const cel = celAt(snapshot.layers, frameNr);
    return {
      frameNr,
      lineImageId: cel ? cel.lineImageId : null,
      colorImageId: cel ? cel.colorImageId : null,
    };
  });

  const passes = separated
    ? snapshot.palette.map((_, index) => ({ index }))
    : [{ index: null }];

  return {
    kind,
    frames,
    passes,
    frameCount: snapshot.frameCount,
    canvasSize: snapshot.canvasSize,
    backgroundColor: snapshot.backgroundColor,
    palette: snapshot.palette,
    layersVisible: snapshot.layersVisible,
    fps: snapshot.fps,
  };
}

/**
 * Enrich a `planExport` result with the target-derived fields that only become
 * known after the save dialog: the format flags, the RGB tracer palette, the
 * SVG quality tier, and each pass's on-disk paths (via `colorPassPaths` for
 * separated passes; the flat pass writes at the chosen path directly). Pure.
 *
 * @param {Object} plan - a successful `planExport` result.
 * @param {string} fullFilePath - the path chosen in the save dialog.
 * @param {Object} [opts]
 * @param {(number|null)} [opts.svgQualityNum]
 * @returns {Object} the plan augmented with { ext, folder, prefix, alphaChannel,
 *   requiresTmpExport, svgQualityNum, rgbPalette, and per-pass path fields }.
 */
export function resolveExportTarget(plan, fullFilePath, { svgQualityNum = null } = {}) {
  const {
    folder, prefix, ext, filePathNoExtBase,
  } = parseExportTarget(fullFilePath);
  const { requiresTmpExport, alphaChannel } = planExportFormat(ext);

  const passes = plan.passes.map((pass) => {
    if (pass.index === null || pass.index === undefined) {
      return {
        ...pass,
        subFolder: null,
        filePathNoExt: filePathNoExtBase,
        filePathMp4: fullFilePath,
      };
    }
    const colorPass = colorPassPaths(folder, prefix, pass.index);
    return {
      ...pass,
      subFolder: colorPass.subFolder,
      filePathNoExt: colorPass.filePathNoExt,
      filePathMp4: colorPass.filePathMp4,
    };
  });

  return {
    ...plan,
    passes,
    ext,
    folder,
    prefix,
    filePathNoExtBase,
    requiresTmpExport,
    alphaChannel,
    svgQualityNum,
    rgbPalette: makeRgbPalette(plan.palette),
  };
}
