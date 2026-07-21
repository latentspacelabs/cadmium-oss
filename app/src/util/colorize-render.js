/**
 * Rasterizes a colorized frame from the model output.
 *
 * The colorize endpoint returns one colour per segment id (`targetColorsRgba`,
 * indexed by segment id). To turn that into an image we read the segment id of
 * every pixel out of the target segmentation map and paint it with its
 * segment's colour.
 *
 * This is the one inherently DOM-bound step of colorization (it needs a canvas
 * to decode the PNG and emit a data URI), so it is kept out of ColorizeService
 * and isolated here behind a single call.
 */
import { getImageDimensions, loadImage } from '@/util/image-util';
import { createCanvas } from '@/util/canvas-util';
import { rgbaArrayToUint32 } from '@/util/color-util';

/**
 * @param {object}     p
 * @param {string}     p.targetSegMapDataUri  data-URI of the target segmentation map.
 * @param {number[][]} p.targetColorsRgba     colour per segment id, [r,g,b,a].
 * @returns {Promise<string>} PNG data URI of the colorized frame.
 */
/* eslint-disable-next-line import/prefer-default-export */
export async function renderColorizedFrame({ targetSegMapDataUri, targetColorsRgba }) {
  const colorsUint32 = targetColorsRgba.map(rgbaArrayToUint32);
  const { width, height } = await getImageDimensions(targetSegMapDataUri);

  // Rasterize the segmentation map so we can read per-pixel segment ids.
  const { ctx: segCtx } = createCanvas({ width, height });
  const segImage = await loadImage(targetSegMapDataUri);
  segCtx.drawImage(segImage, 0, 0);
  const segImageData = segCtx.getImageData(0, 0, segCtx.canvas.width, segCtx.canvas.height);
  const segBytes = new Uint8Array(segImageData.data.buffer);

  // Paint each pixel with the colour assigned to its segment id.
  const { canvas: outCanvas, ctx: outCtx } = createCanvas({ width, height });
  const outImageData = outCtx.getImageData(0, 0, outCtx.canvas.width, outCtx.canvas.height);
  const outPixels = new Uint32Array(outImageData.data.buffer);

  let i = outPixels.length - 1;
  while (i >= 0) {
    // Segment id is stored in the blue byte of the greyscale segmentation map.
    const segId = segBytes[((i + 1) * 4) - 2];
    outPixels[i] = colorsUint32[segId];
    i -= 1;
  }
  outCtx.putImageData(outImageData, 0, 0);
  return outCanvas.toDataURL('image/png', 1.0);
}
