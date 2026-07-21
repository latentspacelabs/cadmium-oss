/**
 * export-run — the export executor (architecture doc §3.4 / §5.3, bug factory
 * F4). The ~450-line EXPORT_DIALOG/EXPORT_FILES orchestration blob is replaced
 * by: a pure plan (`planExport`), a pure per-frame decision (`export-frame`),
 * and this headless-testable effects loop with every dependency injected.
 *
 * `runExport(plan, deps, ctx)`:
 *   deps = { assets, store, encoders, io, render }
 *   ctx  = the JobRunner context ({ throwIfAborted, progress, ... }).
 *
 * What the shape buys us (the two live export bugs, fixed structurally):
 *  - COLD-ASSET BLANK FRAMES: every layer read goes through the AssetStore
 *    (`assets.getAsset`, which hydrates from disk); a genuinely absent drawing
 *    throws `AssetMissingError`, caught in ONE place (`readAsset`) and turned
 *    into "this layer is absent for the frame". No scattered null-skips.
 *  - RE-ENCODING IDENTICAL FRAMES: renders are memoized per
 *    (lineImageId, colorImageId, passIndex) — a hold block renders once and
 *    writes N times.
 *
 * The encoder interface (png/svg/mp4), one per output format:
 *   encoder.open(pass, plan, deps, ctx) -> sink
 *   sink.write(frame, image)   // image = a PNG data URI from the compositor
 *   sink.close()               // mp4 runs ffmpeg here; png/svg are no-ops
 */

import path from 'path';
import mergeImages from 'merge-images';

import {
  createCanvas,
  getColorCanvasDataUri,
  getBlankDataUri,
} from '@/util/canvas-util';
import { loadImage } from '@/util/image-util';
import { getAsset, AssetMissingError } from '@/services/asset-store';
import { paletteFilter, composeFramePlan } from '@/services/export-frame';
import {
  frameExportStem,
  svgTracerOptions,
  normalizeExportFps,
} from '@/services/export-plan';
import { SET_LAST_EXPORT_TIME } from '@/store/mutation-types';

const PNG_DATA_URI_RE = /^data:image\/png;base64,/;
const stripPngDataUri = (dataUri) => dataUri.replace(PNG_DATA_URI_RE, '');

/**
 * The memo key for a rendered composite: the frame's line+color drawing ids and
 * the pass index. Everything else a render depends on (background, palette,
 * layer visibility) is constant for the whole run, so identical cels in the
 * same pass share one render.
 */
function renderKey(frame, pass) {
  const passKey = (pass.index === null || pass.index === undefined) ? 'flat' : pass.index;
  return `${frame.lineImageId || 'none'}:${frame.colorImageId || 'none'}:${passKey}`;
}

/**
 * Read one layer's bytes through the AssetStore. A missing drawing is the
 * single, explicit "no content for this layer" decision — `AssetMissingError`
 * becomes null (layer absent); any other error propagates.
 */
async function readAsset(deps, imageDataId) {
  if (!imageDataId) { return null; }
  try {
    return await deps.assets.getAsset(deps.store, imageDataId);
  } catch (err) {
    if (err instanceof AssetMissingError) { return null; }
    throw err;
  }
}

/**
 * Composite one frame for one pass into a PNG data URI. Pure decision via
 * `composeFramePlan`; the actual drawing is delegated to `deps.render` so the
 * loop stays testable with fakes.
 */
async function renderFrame(frame, pass, plan, deps) {
  const { render } = deps;
  const colorImage = await readAsset(deps, frame.colorImageId);
  const lineImage = await readAsset(deps, frame.lineImageId);

  const layers = composeFramePlan({
    hasColor: colorImage !== null,
    hasLine: lineImage !== null,
    pass,
    layersVisible: {
      line: plan.layersVisible.line,
      color: plan.layersVisible.color,
      background: !plan.alphaChannel,
    },
  });

  const images = [];
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    if (layer.kind === 'background') {
      images.push(await render.backgroundImage(plan.canvasSize, plan.backgroundColor));
    } else if (layer.kind === 'blank') {
      images.push(await render.blankImage(plan.canvasSize));
    } else if (layer.kind === 'line') {
      images.push(lineImage);
    } else if (layer.kind === 'color') {
      images.push(layer.filterIndex === null
        ? colorImage
        : await render.filterColor(colorImage, plan.canvasSize, plan.palette[layer.filterIndex]));
    }
  }
  /* eslint-enable no-await-in-loop */

  return render.merge(images);
}

/**
 * Run an export plan. Per-pass: make the subfolder (colors-separated only) and
 * open the encoder; per-frame: cancel-check, render (memoized), write, report
 * progress. `sink.close()` finishes the pass (mp4 encodes here).
 *
 * @param {Object} plan - a `resolveExportTarget`-finalized `planExport` result.
 * @param {Object} deps - { assets, store, encoders, io, render }.
 * @param {Object} ctx - the JobRunner context.
 * @returns {Promise<{ files:number, passes:number }>}
 */
export async function runExport(plan, deps, ctx) {
  const { encoders, io } = deps;
  const encoder = encoders[plan.ext] || encoders.png;
  const total = plan.passes.length * plan.frames.length;
  const renderCache = new Map();
  let done = 0;
  // Measure real throughput as we go: the waiting screen's estimate is
  // `remaining × lastExportTime`, and without a measurement that factor is a
  // hardcoded 10 s/item — off by ~100× for PNG frames, so colors-separated
  // exports claimed minutes. The running average self-corrects the estimate
  // after the first item and seeds the next run's initial guess.
  const startedAt = Date.now();

  /* eslint-disable no-await-in-loop */
  for (let p = 0; p < plan.passes.length; p += 1) {
    const pass = plan.passes[p];
    ctx.throwIfAborted();
    if (pass.subFolder) { await io.mkdir(pass.subFolder); }
    const sink = await encoder.open(pass, plan, deps, ctx);

    for (let f = 0; f < plan.frames.length; f += 1) {
      const frame = plan.frames[f];
      ctx.throwIfAborted();
      const key = renderKey(frame, pass);
      if (!renderCache.has(key)) {
        renderCache.set(key, renderFrame(frame, pass, plan, deps));
      }
      const image = await renderCache.get(key);
      await sink.write(frame, image);
      done += 1;
      ctx.progress(done, total);
      deps.store.commit(SET_LAST_EXPORT_TIME, ((Date.now() - startedAt) / 1000) / done);
    }

    await sink.close();
    // Keys include the pass index, so a finished pass's entries can never be
    // hit again — drop them or a colors-separated export retains every pass's
    // multi-MB composites (palette.length × cels) until the run ends.
    renderCache.clear();
  }
  /* eslint-enable no-await-in-loop */

  return { files: total, passes: plan.passes.length };
}

// ─── encoders ────────────────────────────────────────────────────────────────

/**
 * png — direct file write of the composited PNG.
 */
export function createPngEncoder() {
  return {
    async open(pass, plan, deps) {
      const { io } = deps;
      return {
        async write(frame, image) {
          const { stem } = frameExportStem(pass.filePathNoExt, frame.frameNr, plan.frameCount);
          await io.writeFile(`${stem}.png`, stripPngDataUri(image), 'base64');
        },
        async close() { /* png writes per frame; nothing to finalize */ },
      };
    },
  };
}

/**
 * Promisified png.js parse — untangles the original callback pyramid.
 */
function parsePng(PNGReader, bytes) {
  return new Promise((resolve, reject) => {
    const reader = new PNGReader(bytes);
    reader.parse((err, png) => (err ? reject(err) : resolve(png)));
  });
}

/**
 * svg — write a temp PNG, decode it (png.js), trace to SVG (ImageTracer) with
 * the plan's quality preset + RGB palette, write the .svg. Same outputs as the
 * old callback-pyramid path; `tracer` = { PNGReader, imagedataToSVG } injected.
 */
export function createSvgEncoder({ tracer }) {
  return {
    async open(pass, plan, deps) {
      const { io } = deps;
      const options = svgTracerOptions(plan.svgQualityNum, plan.rgbPalette);
      return {
        async write(frame, image) {
          const { paddedFrameNr, stem } = frameExportStem(
            pass.filePathNoExt, frame.frameNr, plan.frameCount,
          );
          const tmpPath = path.join(io.tmpDir(), `export_${io.now()}_${paddedFrameNr}.png`);
          await io.writeFile(tmpPath, stripPngDataUri(image), 'base64');
          io.addTempFile(tmpPath);

          const bytes = await io.readFile(tmpPath);
          const png = await parsePng(tracer.PNGReader, bytes);
          const imageData = { width: png.width, height: png.height, data: png.pixels };
          const svgString = await tracer.imagedataToSVG(imageData, options);
          await io.writeFile(`${stem}.svg`, svgString);
        },
        async close() { /* svg writes per frame; nothing to finalize */ },
      };
    },
  };
}

/**
 * mp4 — accumulate temp PNGs per frame, then on close pipe them through the
 * existing ffmpeg invocation (moved verbatim). `ffmpeg` = { createConverter,
 * ffmpegPath } injected; the frame streaming lives in `io.pipeFramesToConverter`.
 */
export function createMp4Encoder({ ffmpeg }) {
  return {
    async open(pass, plan, deps) {
      const { io } = deps;
      const tmpPaths = [];
      return {
        async write(frame, image) {
          const { paddedFrameNr } = frameExportStem(
            pass.filePathNoExt, frame.frameNr, plan.frameCount,
          );
          const tmpPath = path.join(io.tmpDir(), `export_${io.now()}_${paddedFrameNr}.png`);
          await io.writeFile(tmpPath, stripPngDataUri(image), 'base64');
          io.addTempFile(tmpPath);
          tmpPaths.push(tmpPath);
        },
        async close() {
          const outPath = pass.filePathMp4;
          if (io.fileExists(outPath)) { io.unlink(outPath); }
          const converter = ffmpeg.createConverter();
          converter.setPath(ffmpeg.ffmpegPath);
          const fps = normalizeExportFps(plan.fps);
          const input = converter.createInputStream({ f: 'image2pipe', r: fps });
          converter.createOutputToFile(outPath, {
            vcodec: 'libx264',
            pix_fmt: 'yuv420p',
            vf: 'pad = ceil(iw / 2) * 2: ceil(ih / 2) * 2',
            r: fps,
          });
          await io.pipeFramesToConverter(tmpPaths, input, converter);
        },
      };
    },
  };
}

// ─── production dependency wiring (lazy, so tests never touch native deps) ────

function createExportRender() {
  return {
    backgroundImage: (size, color) => getColorCanvasDataUri(size, color),
    blankImage: (size) => getBlankDataUri(size),
    merge: (images) => mergeImages(images),
    async filterColor(colorImage, size, paletteEntry) {
      const { canvas, ctx } = createCanvas(size);
      const img = await loadImage(colorImage);
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, size.width, size.height);
      paletteFilter(imageData, paletteEntry);
      ctx.putImageData(imageData, 0, 0);
      return canvas.toDataURL('image/png', 1.0);
    },
  };
}

function createExportIo() {
  const fs = require('fs');
  const { defineTempDir } = require('@/util/file-util');
  const { addTempFile } = require('@/platform');
  return {
    mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
    writeFile: (filePath, data, encoding) => fs.promises.writeFile(filePath, data, encoding),
    readFile: (filePath) => fs.promises.readFile(filePath),
    fileExists: (filePath) => fs.existsSync(filePath),
    unlink: (filePath) => fs.unlinkSync(filePath),
    tmpDir: () => defineTempDir(),
    addTempFile: (filePath) => addTempFile(filePath),
    now: () => new Date().getTime(),
    pipeFramesToConverter(tmpPaths, input, converter) {
      return new Promise((resolve) => {
        tmpPaths
          .map((fileName) => () => new Promise((res, rej) => fs
            .createReadStream(fileName)
            .on('end', res)
            .on('error', rej)
            .pipe(input, { end: false })))
          .reduce((prev, next) => prev.then(next), Promise.resolve())
          .then(() => input.end());
        converter.run();
        resolve();
      });
    },
  };
}

/**
 * Wire the real production dependencies. Native/Electron libs (png.js,
 * ffmpeg-stream-with-path, @/binaries, fs, platform) are lazily required here so
 * importing this module for unit tests never pulls them in.
 *
 * @param {Object} store - Vuex store or action context ({ getters, commit, dispatch }).
 * @returns {Object} deps for `runExport`.
 */
export function createExportDeps(store) {
  const PNGReader = require('png.js');
  const ImageTracer = require('imagetracerjs');
  const { Converter } = require('ffmpeg-stream-with-path');
  const { ffmpegPath } = require('@/binaries');

  return {
    assets: { getAsset },
    store,
    render: createExportRender(),
    io: createExportIo(),
    encoders: {
      png: createPngEncoder(),
      svg: createSvgEncoder({
        tracer: {
          PNGReader,
          imagedataToSVG: (data, options) => ImageTracer.imagedataToSVG(data, options),
        },
      }),
      mp4: createMp4Encoder({
        ffmpeg: { createConverter: () => new Converter(), ffmpegPath },
      }),
    },
  };
}
