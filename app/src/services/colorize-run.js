/**
 * colorize-run — the colorize/analyze executor (architecture doc §3.4 / §5.2,
 * bug factory F4). The ~670-line COLORIZE orchestration blob — which served both
 * the "colorize" and "analyze" verbs through the `analyzeModeOnly` flag — is
 * replaced by: a pure plan (`planColorize`, in colorize-plan.js), and this
 * headless-testable effects loop with every dependency injected.
 *
 *   runColorize(plan, deps, ctx)   // colorize verb (plan.analyzeMode === false)
 *   runAnalyze(plan, deps, ctx)    // analyze verb  (plan.analyzeMode === true)
 *   analyzeRef(refInputs, deps)    // single-reference analyze, shared with
 *                                  //   ANALYZE_CURRENT_FRAME (color-import path)
 *
 *   deps = { store, assets, server, io }
 *     store  = a Vuex store or action ctx ({ state, getters, commit, dispatch })
 *     assets = { tryGetAsset, putAsset }            (asset-store.js)
 *     server = { colorizeFrame, analyzeReference }  (colorize-service.js)
 *     io     = fs / segmentation / canvas / temp-file effects (injected)
 *   ctx  = the JobRunner context ({ throwIfAborted, progress, ... }).
 *
 * What the shape buys us:
 *  - `analyzeModeOnly` no longer reaches the loop internals: the wrapper reads it
 *    once to pick the verb; the plan carries `analyzeMode`.
 *  - NO dialogs live here. The two old mid-loop dialogs are now PLAN-time errors
 *    (`planColorize`); the four run-time dialogs become typed error RESULTS
 *    (`{ error, errorFrameNr }`) that the UI wrapper maps to dialogs.
 *  - The dupe session map (`lineImageIdToColorImageIdMap`) is a plain local,
 *    seeded once via `buildRefLineToColorImageIdMap`, with its reuse branch in
 *    ONE place (`isDupe`).
 *  - THE PALETTE FIX: `/colorize` never returns `target_palette_rgba`, so the
 *    old palette path was dead. The palette now comes from the `/preprocess`
 *    response (`result.preprocessPaletteRgba`) and is merged idempotently per
 *    colorize call — see `mergePaletteInto`.
 *
 * Cancellation: one semantics — `ctx.throwIfAborted()` at each op boundary,
 * driven by the JobRunner's AbortSignal (cancelJob). Server-side cancels still
 * surface via the `canceled` return / non-OK status and end the run cleanly.
 */

import { buildSegMapFileName } from '@/util/segmap-path';
import {
  buildRefLineToColorImageIdMap,
  pickInBetweenRefFrame,
} from '@/services/colorize-plan';
import { extractPaletteRgba } from '@/services/palette-recolor';
import { attachColorToCel, mergePalette } from '@/services/document';
import {
  colorizeFrame,
  analyzeReference,
  COLORIZE_STATUS,
} from '@/services/colorize-service';
import { tryGetAsset, putAsset } from '@/services/asset-store';

import {
  LINKED_LAYER_ID,
  AI_GAP_CLOSER_ENABLED,
  MAX_AI_DILATION_SIZE,
  MAX_TB_DILATION_SIZE,
  MIN_SEG_SIZE,
  LINE_THRESHOLD,
  IS_AUTO_ALPHA,
  CANVAS_SIZE,
  PROJECT_ID,
  RAINBOW_MODE,
  FRAMES_BY_LAYER_ID,
  FRAME_BY_FRAME_NR,
  IMAGE_DATA_OF_FRAME,
  IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID,
  IMAGE_DATA_URI_BY_IMAGE_DATA_ID,
  SELECTED_FRAMES_ON_LAYER,
} from '@/store/getter-types';

import {
  SET_FRAMES_TO_LOADING,
  DESELECT_FRAMES,
  SET_FRAMES_SELECTED,
  SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID,
  SET_CURRENT_PROCESSING_TASK,
  SET_TIME_FOR_LAST_SEGMENTATION_MAP_GENERATION,
  SET_TIME_FOR_LAST_COLORIZATION,
  SET_SELECTED_FRAME_NUMBER,
  SET_CANVAS_REDRAW_TRIGGER,
  INCREMENT_IMAGE_DATA_USAGE_BY_IMAGE_DATA_ID,
  REPLACE_IMAGE_DATA_URI,
} from '@/store/mutation-types';

import {
  TOGGLE_FRAME_SELECTION,
  HANDLE_FRAME_DELETE,
} from '@/store/action-types';

import {
  INITIAL_COLOR_LAYER_ID,
  TASK_SEGMENTATION_MAP_GENERATION,
  TASK_COLORIZATION,
} from '@/store/general-types';

/**
 * Typed run-time error codes. Each is the executor-side replacement of one of
 * COLORIZE's mid-loop `showCustomDialog` calls; the wrapper maps the code back
 * to the same dialog. (The two PLAN-time codes live in colorize-plan.js.)
 */
export const COLORIZE_RUN_ERROR = {
  LINE_DATA_MISSING: 'LINE_DATA_MISSING', // colorize: target/ref line/ref color URI absent
  ANALYZE_LINE_MISSING: 'ANALYZE_LINE_MISSING', // analyze: target line URI absent
  TOO_MANY_SEGMENTS: 'TOO_MANY_SEGMENTS', // segmentation returned > 255 segments
  COLORIZE_FAILED: 'COLORIZE_FAILED', // the /colorize call threw
};

const MAX_SEGMENTS = 255;

/**
 * Gather the run-time settings from the store getters (dilation sizes,
 * thresholds, project/canvas, rainbow). Read once per run.
 */
function readSettings(store) {
  const g = store.getters;
  const colorLayerId = INITIAL_COLOR_LAYER_ID;
  const aiGapCloserEnabled = g[AI_GAP_CLOSER_ENABLED];
  return {
    colorLayerId,
    lineLayerId: g[LINKED_LAYER_ID](colorLayerId),
    aiDilationAmount: aiGapCloserEnabled ? g[MAX_AI_DILATION_SIZE] : 0,
    tbDilationAmount: g[MAX_TB_DILATION_SIZE],
    minSegSize: g[MIN_SEG_SIZE],
    lineThreshold: g[LINE_THRESHOLD],
    isAutoAlpha: g[IS_AUTO_ALPHA],
    canvasSize: g[CANVAS_SIZE],
    projectId: g[PROJECT_ID],
  };
}

/**
 * Merge a palette-rgba array into the document palette, committing one
 * ADD_COLOR_TO_PALETTE per genuinely-new swatch. Idempotent (dedupe by hex via
 * the pure `mergePaletteRgba`), so re-merging the same reference adds nothing.
 *
 * @returns {number} how many swatches were added.
 */
function mergePaletteInto(store, respPaletteRgba) {
  return mergePalette(store, respPaletteRgba);
}

// Encode a segmap file as a data URI — the two `base64Encode(segPath, ...)` call
// sites in the colorize branch read clean through this.
function encodeSegAsDataUri(deps, filePath) {
  return deps.io.base64Encode(filePath, { asDataUri: true });
}

// Thin getter shorthands, so the loop below stays readable.
const frameByNr = (store, layerId, frameNr) => (
  store.getters[FRAME_BY_FRAME_NR]({ layerId, frameNr })
);
const imageDataOfFrame = (store, layerId, frameNr) => (
  store.getters[IMAGE_DATA_OF_FRAME]({ layerId, frameNr })
);
const hashOfImage = (store, id) => store.getters[IMAGE_DATA_OBJECT_BY_IMAGE_DATA_ID](id).hash;
const imageDataUri = (store, id) => store.getters[IMAGE_DATA_URI_BY_IMAGE_DATA_ID](id);

/**
 * Ensure a segmentation map exists on disk for a drawing, reusing the cached
 * file when the deterministic name (hash + settings) already exists — the exact
 * caching semantics of the old COLORIZE (and ANALYZE_CURRENT_FRAME) segmap
 * blocks. Shared by the target and reference paths.
 *
 * On a cache hit: commits the path, no /segment call. On a miss: writes the
 * source PNG to a temp file, registers it, runs /segment, and commits the new
 * path (unless canceled / over the segment limit).
 *
 * @returns {Promise<{ segPath?: string, canceled?: boolean, tooManySegments?: boolean }>}
 */
async function ensureSegMap(deps, {
  segImageId, genImageId, hash, settings, checkLimit, resolveSourceDataUri,
}) {
  const { store, io } = deps;

  const segFileName = buildSegMapFileName({
    hash,
    lineThreshold: settings.lineThreshold,
    isAutoAlpha: settings.isAutoAlpha,
    tbDilationSize: settings.tbDilationAmount,
    aiDilationSize: settings.aiDilationAmount,
    minSegSize: settings.minSegSize,
  });
  const segPath = io.pathJoin(io.tmpDir(), segFileName);

  if (io.fileExists(segPath)) {
    store.commit(SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID, {
      imageDataId: segImageId,
      segmentationMapPath: segPath,
    });
    return { segPath };
  }

  store.commit(SET_CURRENT_PROCESSING_TASK, TASK_SEGMENTATION_MAP_GENERATION);
  const tmpFileName = `cadm_tmp_trgt_${io.now()}_${hash}.png`;
  const tmpFilePath = io.pathJoin(io.tmpDir(), tmpFileName);
  const sourceDataUri = await resolveSourceDataUri();
  await io.writeBase64DataToFile(tmpFilePath, io.getRaw(sourceDataUri));
  io.addTempFile(tmpFilePath);

  const {
    path: newSegPath, processingTimeInSec, numSegments, canceled,
  } = await io.generateSegmentationMap({
    projectId: settings.projectId,
    srcFilename: tmpFileName,
    srcPath: tmpFilePath,
    // QUIRK preserved: the reference path passes the TARGET's image id here too
    // (the caller sets genImageId), matching the original action verbatim.
    imageId: genImageId,
    aiDilationSize: settings.aiDilationAmount,
    tbDilationSize: settings.tbDilationAmount,
    line_threshold: settings.lineThreshold,
    is_auto_alpha: settings.isAutoAlpha,
    minSegSize: settings.minSegSize,
    canvSize: settings.canvasSize,
  });

  if (canceled) { return { canceled: true }; }
  if (checkLimit && numSegments > MAX_SEGMENTS) { return { tooManySegments: true }; }

  store.commit(SET_TIME_FOR_LAST_SEGMENTATION_MAP_GENERATION, processingTimeInSec);
  store.commit(SET_SEGMENTATION_MAP_PATH_FOR_IMAGE_WITH_ID, {
    imageDataId: segImageId,
    segmentationMapPath: newSegPath,
  });
  return { segPath: newSegPath };
}

/**
 * Delete the color frame currently attached at `frameNr` (and its duplicates)
 * before re-attaching the freshly colorized image, so re-colorizing with the
 * same reference/settings does not leave a duplicate image in the store. Moved
 * verbatim from COLORIZE; mutates `selectedFrameNrs` in place.
 */
async function deleteExistingColorFrame(deps, { frameNr, selectedFrameNrs, settings }) {
  const { store } = deps;
  const { colorLayerId } = settings;

  store.commit(DESELECT_FRAMES, { layerId: colorLayerId, frameNrs: selectedFrameNrs });
  await store.dispatch(TOGGLE_FRAME_SELECTION, { layerId: colorLayerId, frameNr });

  const selectedCurrFrames = store.getters[SELECTED_FRAMES_ON_LAYER](colorLayerId).filter(Boolean);
  for (let i = 0; i < selectedCurrFrames.length; i += 1) {
    const frIndex = selectedFrameNrs.indexOf(selectedCurrFrames[i].frameNr);
    if (frIndex !== -1) { selectedFrameNrs.splice(frIndex, 1); }
  }

  await store.dispatch(HANDLE_FRAME_DELETE);
  store.commit(SET_FRAMES_SELECTED, { layerId: colorLayerId, frameNrs: selectedFrameNrs });
}

/**
 * Persist the model's reference-preprocessed / target-warped debug images as
 * temp files (unchanged from COLORIZE). Purely a debug side effect.
 */
async function writeDebugImages(deps, result) {
  const { io } = deps;
  const debugImageMap = {};
  if (result.refPreprocessed) { debugImageMap.ref_preprocessed = result.refPreprocessed; }
  if (result.targetWarped) { debugImageMap.target_warped = result.targetWarped; }
  const names = Object.keys(debugImageMap);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    const filePath = io.pathJoin(io.tmpDir(), `cadm_tmp_${name}_${io.now()}.png`);
    /* eslint-disable-next-line no-await-in-loop */
    await io.writeBase64DataToFile(filePath, debugImageMap[name]);
    io.addTempFile(filePath);
  }
}

/**
 * The rainbow-mode analyze render: turn the analyzed color-segment image into an
 * editable color frame. Analyze-mode-only; preserved verbatim from COLORIZE.
 */
async function renderRainbowFrame(deps, { frameNr, segMapPath, settings }) {
  const { store, io } = deps;
  const segMapPathParts = segMapPath.split('.');
  const segMapColorPath = segMapPathParts[0].concat('_color_seg.', segMapPathParts[1]);
  const analyzedColorSegDataUri = await io.base64Encode(segMapColorPath, { asDataUri: true });

  const { width, height } = await io.getImageDimensions(analyzedColorSegDataUri);
  const { canvas, ctx } = io.createCanvas({ width, height });
  const colorImgSeg = await io.loadImage(analyzedColorSegDataUri);
  ctx.drawImage(colorImgSeg, 0, 0);
  const colorImgImageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.putImageData(colorImgImageData, 0, 0);
  const newColorDataUri = canvas.toDataURL('image/png', 1.0);

  const analyzedColorSegDataId = await deps.assets.putAsset(
    store, newColorDataUri, { forceNew: true },
  );
  attachColorToCel(store, {
    frameNr,
    imageDataId: analyzedColorSegDataId,
    isOriginal: false,
    force: true,
  });
  return analyzedColorSegDataId;
}

/**
 * Run a colorize plan (or an analyze plan — the two verbs share this loop, which
 * branches on `plan.analyzeMode`). Returns `{ colorizedFrames }` on success, or
 * `{ error, errorFrameNr }` for a typed run-time failure, or `{ canceled: true }`
 * on a server-side cancel. A JobRunner abort throws `JobCanceledError` out.
 *
 * @param {Object} plan - from `planColorize` / `planAnalyze`.
 * @param {Object} deps - { store, assets, server, io }.
 * @param {Object} ctx - the JobRunner context.
 */
export async function runColorize(plan, deps, ctx) {
  try {
    return await runColorizeLoop(plan, deps, ctx);
  } finally {
    // The loop marks every planned frame isLoading up front; EVERY exit —
    // success, typed error, server cancel, or a JobRunner abort throwing out —
    // must clear the flag or the timeline shows stuck spinners (the old code's
    // cancel poll did this; the abort/error paths must too).
    deps.store.commit(SET_FRAMES_TO_LOADING, {
      layerId: INITIAL_COLOR_LAYER_ID,
      frameNrs: plan.ops.map((op) => op.frameNr),
      isLoading: false,
    });
  }
}

async function runColorizeLoop(plan, deps, ctx) {
  const { store } = deps;
  const analyzeMode = !!plan.analyzeMode;
  const settings = readSettings(store);
  const { colorLayerId, lineLayerId } = settings;

  const total = plan.ops.length;
  const selectedFrameNrs = plan.ops.map((op) => op.frameNr);
  let colorizedFrames = 0;

  store.commit(SET_FRAMES_TO_LOADING, { layerId: colorLayerId, frameNrs: selectedFrameNrs });
  ctx.progress(colorizedFrames, total);

  // The dupe session map: reference line-image-id -> original color-image-id,
  // extended with each freshly colorized image. Seeded ONCE; the sole reuse
  // site is the `isDupe` branch below.
  const lineImageIdToColorImageIdMap = {
    ...buildRefLineToColorImageIdMap(
      store.getters[FRAMES_BY_LAYER_ID](lineLayerId),
      store.getters[FRAMES_BY_LAYER_ID](colorLayerId),
    ),
  };
  const colorizedFrameNrs = [];

  /* eslint-disable no-await-in-loop, no-continue */
  for (let i = 0; i < plan.ops.length; i += 1) {
    const op = plan.ops[i];
    ctx.throwIfAborted();

    const { frameNr } = op;
    const targetLineFrame = frameByNr(store, lineLayerId, frameNr);

    // Original frames need no processing — count them as progress and move on.
    if (op.isOriginal) {
      store.commit(SET_FRAMES_TO_LOADING, {
        layerId: colorLayerId, frameNrs: [frameNr], isLoading: false,
      });
      store.commit(DESELECT_FRAMES, { layerId: colorLayerId, frameNrs: [frameNr] });
      const refIndex = selectedFrameNrs.indexOf(frameNr);
      if (refIndex !== -1) { selectedFrameNrs.splice(refIndex, 1); }
      colorizedFrames += 1;
      ctx.progress(colorizedFrames, total);
      continue;
    }

    let searchNewPalette = true;
    let { refFrameNr } = op;
    // Analyze mode tolerated a missing reference (the planner does not error);
    // fall back to the first selected frame exactly as the action did.
    if (!refFrameNr && analyzeMode) { refFrameNr = selectedFrameNrs[0]; }
    let refLineFrame = frameByNr(store, lineLayerId, refFrameNr);

    if (!analyzeMode) {
      // Sequential colorization: prefer an in-between frame already colorized
      // this run (farthest from the reference) so each new frame references its
      // fresh neighbour. Using an in-between ref suppresses the palette re-search.
      const inBetween = pickInBetweenRefFrame({ frameNr, refFrameNr, colorizedFrameNrs });
      if (inBetween !== null) {
        refFrameNr = inBetween;
        refLineFrame = frameByNr(store, lineLayerId, refFrameNr);
        searchNewPalette = false;
      }
    }

    const targetLineB64DataUri = await deps.assets.tryGetAsset(store, targetLineFrame.imageDataId);
    const refColorB64DataUri = imageDataOfFrame(store, colorLayerId, refFrameNr);
    const refLineB64DataUri = imageDataOfFrame(store, lineLayerId, refFrameNr);

    if (!targetLineB64DataUri || !refColorB64DataUri || !refLineB64DataUri) {
      if (!analyzeMode) {
        return { error: COLORIZE_RUN_ERROR.LINE_DATA_MISSING, errorFrameNr: frameNr };
      }
      if (!targetLineB64DataUri) {
        return { error: COLORIZE_RUN_ERROR.ANALYZE_LINE_MISSING, errorFrameNr: frameNr };
      }
    }

    const isDupe = Object.prototype.hasOwnProperty.call(
      lineImageIdToColorImageIdMap, targetLineFrame.imageDataId,
    );

    if (!isDupe) {
      const currHash = hashOfImage(store, targetLineFrame.imageDataId);

      const targetSeg = await ensureSegMap(deps, {
        segImageId: targetLineFrame.imageDataId,
        genImageId: targetLineFrame.imageDataId,
        hash: currHash,
        settings,
        checkLimit: true,
        resolveSourceDataUri: async () => imageDataUri(store, targetLineFrame.imageDataId),
      });
      if (targetSeg.canceled) { return { canceled: true }; }
      if (targetSeg.tooManySegments) {
        return { error: COLORIZE_RUN_ERROR.TOO_MANY_SEGMENTS, errorFrameNr: frameNr };
      }
      const segMapPath = targetSeg.segPath;

      let refSegPath;
      if (!analyzeMode) {
        const refHash = hashOfImage(store, refLineFrame.imageDataId);
        const refSeg = await ensureSegMap(deps, {
          segImageId: refLineFrame.imageDataId,
          genImageId: targetLineFrame.imageDataId, // QUIRK preserved (see ensureSegMap)
          hash: refHash,
          settings,
          checkLimit: false,
          resolveSourceDataUri: async () => (
            deps.assets.tryGetAsset(store, refLineFrame.imageDataId)
          ),
        });
        if (refSeg.canceled) { return { canceled: true }; }
        refSegPath = refSeg.segPath;
      }

      if (!analyzeMode) {
        store.commit(SET_CURRENT_PROCESSING_TASK, TASK_COLORIZATION);
        const targetSegB64DataUri = await encodeSegAsDataUri(deps, segMapPath);
        const refSegB64DataUri = await encodeSegAsDataUri(deps, refSegPath);
        const colorizationStartTime = deps.io.now();

        let result;
        try {
          result = await deps.server.colorizeFrame({
            projectId: settings.projectId,
            refs: [{
              colorRaw: deps.io.getRaw(refColorB64DataUri),
              segMapRaw: deps.io.getRaw(refSegB64DataUri),
              lineRaw: deps.io.getRaw(refLineB64DataUri),
            }],
            target: {
              lineRaw: deps.io.getRaw(targetLineB64DataUri),
              segMapRaw: deps.io.getRaw(targetSegB64DataUri),
            },
            isAutoAlpha: settings.isAutoAlpha,
            lineThreshold: settings.lineThreshold,
          });

          if (result.status !== COLORIZE_STATUS.OK) {
            // canceled / no-internet / server-error: the server layer already
            // surfaced any dialog. Stop cleanly, keeping finished frames.
            return { serverStatus: result.status };
          }

          // Drop the current color image (and dupes) before re-attaching, to
          // avoid duplicate-image issues on a re-colorize with same ref/settings.
          await deleteExistingColorFrame(deps, { frameNr, selectedFrameNrs, settings });

          const colorizedImageDataUri = await deps.io.renderColorizedFrame({
            targetSegMapDataUri: targetSegB64DataUri,
            targetColorsRgba: result.targetColorsRgba,
          });

          // LEGACY palette path (kept gated by searchNewPalette): dead on the
          // OSS server, which never returns target_palette_rgba.
          if (result.targetPaletteRgba && searchNewPalette) {
            mergePaletteInto(store, extractPaletteRgba(result.raw));
          }
          // THE FIX: merge the /preprocess palette (per unique reference,
          // naturally idempotent) so a colorize run populates the palette even
          // when /colorize returns only target_colors_rgba.
          mergePaletteInto(store, result.preprocessPaletteRgba);

          await writeDebugImages(deps, result);
          colorizedFrameNrs.push(frameNr);

          store.commit(
            SET_TIME_FOR_LAST_COLORIZATION, (deps.io.now() - colorizationStartTime) / 1000,
          );

          const colorizedImageId = await deps.assets.putAsset(store, colorizedImageDataUri);
          attachColorToCel(store, {
            frameNr,
            imageDataId: colorizedImageId,
            isOriginal: false,
          });
          lineImageIdToColorImageIdMap[targetLineFrame.imageDataId] = colorizedImageId;
        } catch (err) {
          // A server-side cancel already showed its own dialog; anything else is
          // a genuine failure the wrapper renders as "Colorization Failed".
          if (result && result.status === COLORIZE_STATUS.CANCELED) {
            return { serverStatus: COLORIZE_STATUS.CANCELED };
          }
          return { error: COLORIZE_RUN_ERROR.COLORIZE_FAILED, errorFrameNr: frameNr, cause: err };
        }
      } else if (store.getters[RAINBOW_MODE] === 'on') {
        const rainbowId = await renderRainbowFrame(deps, { frameNr, segMapPath, settings });
        lineImageIdToColorImageIdMap[targetLineFrame.imageDataId] = rainbowId;
      }

      store.commit(SET_SELECTED_FRAME_NUMBER, frameNr); // move timeline handle
    } else {
      // DUPE: this line art was already colorized this run — reuse the result.
      const colorizedImageDataId = lineImageIdToColorImageIdMap[targetLineFrame.imageDataId];
      attachColorToCel(store, {
        frameNr,
        imageDataId: colorizedImageDataId,
        isOriginal: false,
      });
      store.commit(INCREMENT_IMAGE_DATA_USAGE_BY_IMAGE_DATA_ID, colorizedImageDataId);
    }

    store.commit(SET_FRAMES_TO_LOADING, {
      layerId: colorLayerId, frameNrs: [frameNr], isLoading: false,
    });
    store.commit(SET_CANVAS_REDRAW_TRIGGER);

    if (analyzeMode) {
      store.commit(DESELECT_FRAMES, { layerId: colorLayerId, frameNrs: [frameNr] });
    }

    colorizedFrames += 1;
    ctx.progress(colorizedFrames, total);
  }
  /* eslint-enable no-await-in-loop, no-continue */

  return { colorizedFrames };
}

/**
 * Analyze verb: the same loop, with `plan.analyzeMode === true`. Kept as its own
 * name so the wrapper reads as two verbs and the shared internals are explicit.
 */
export function runAnalyze(plan, deps, ctx) {
  return runColorize({ ...plan, analyzeMode: true }, deps, ctx);
}

/**
 * Analyze a single reference frame: preprocess it (server), merge its palette
 * into the document, and replace the color image with the preprocessed render.
 * The color-import auto-analyze core, shared with ANALYZE_CURRENT_FRAME.
 *
 * The heavy segmap/canny preparation stays in ANALYZE_CURRENT_FRAME; this owns
 * the server call + palette + preprocessed-uri replace, so both paths share one
 * implementation.
 *
 * @param {Object} refInputs - { segMapDataUri, refColorDataUri, targetLineDataUri, colorImageId }
 * @param {Object} deps - { store, server, io } (assets unused).
 * @returns {Promise<Object>} the analyzeReference result.
 */
export async function analyzeRef(refInputs, deps) {
  const { store, io } = deps;
  const settings = readSettings(store);
  const {
    segMapDataUri, refColorDataUri, targetLineDataUri, colorImageId,
  } = refInputs;

  const result = await deps.server.analyzeReference({
    projectId: settings.projectId,
    ref: {
      colorRaw: io.getRaw(refColorDataUri),
      segMapRaw: io.getRaw(segMapDataUri),
      lineRaw: io.getRaw(targetLineDataUri),
    },
    isAutoAlpha: settings.isAutoAlpha,
    lineThreshold: settings.lineThreshold,
  });

  if (result.refPaletteRgba) {
    mergePaletteInto(store, extractPaletteRgba(result.raw));
  }
  if (result.refPreprocessed) {
    store.commit(REPLACE_IMAGE_DATA_URI, {
      imageDataId: colorImageId, dataUri: result.refPreprocessed,
    });
  }
  return result;
}

// ─── production dependency wiring (lazy, so tests never touch native deps) ────

/**
 * Wire the real production dependencies. fs / Electron / canvas / segmentation
 * libs are lazily required here so importing this module for unit tests never
 * pulls them in (mirrors export-run's `createExportDeps`).
 *
 * @param {Object} store - Vuex store or action ctx ({ state, getters, commit, dispatch }).
 * @returns {Object} deps for `runColorize` / `runAnalyze` / `analyzeRef`.
 */
export function createColorizeDeps(store) {
  const path = require('path');
  const fs = require('fs');
  const {
    base64Encode,
    writeBase64DataToFile,
    defineTempDir,
    getRawDataFromDataUri,
  } = require('@/util/file-util');
  const { generateSegmentationMap } = require('@/util/segmentation');
  const { renderColorizedFrame } = require('@/util/colorize-render');
  const { getImageDimensions, loadImage } = require('@/util/image-util');
  const { createCanvas } = require('@/util/canvas-util');
  const { addTempFile, requestTempFiles } = require('@/platform');

  return {
    store,
    assets: { tryGetAsset, putAsset },
    server: { colorizeFrame, analyzeReference },
    io: {
      pathJoin: (...parts) => path.join(...parts),
      tmpDir: () => defineTempDir(),
      now: () => Date.now(),
      fileExists: (filePath) => fs.existsSync(filePath),
      writeBase64DataToFile: (filePath, raw) => writeBase64DataToFile(filePath, raw),
      addTempFile: (filePath) => addTempFile(filePath),
      requestTempFiles: () => requestTempFiles(),
      base64Encode: (filePath, opts) => base64Encode(filePath, opts),
      getRaw: (dataUri) => getRawDataFromDataUri(dataUri),
      generateSegmentationMap: (params) => generateSegmentationMap(params),
      renderColorizedFrame: (params) => renderColorizedFrame(params),
      getImageDimensions: (dataUri) => getImageDimensions(dataUri),
      createCanvas: (size) => createCanvas(size),
      loadImage: (dataUri) => loadImage(dataUri),
    },
  };
}
