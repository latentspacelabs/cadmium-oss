/* eslint-disable prefer-destructuring */
/* eslint-disable no-inner-declarations */ // disabled to allow a function within a function.
/* eslint-disable  */
import {
  getImageDimensions,
  loadImage,
} from '@/util/image-util';

import { createCanvas } from '@/util/canvas-util';
import { rgbaArrayToUint32 } from '@/util/color-util';

/**
 *
 * @param {Object} o
 * @param {Array} o.color - RGBA-Array in range [0..255], e.g. [255, 0, 0, 255] (red)
 * @todo: If no line image is given it should flood fill anyways. In this case a white image
 *   must be created to use instead of a real line image.
 */
/* eslint-disable import/prefer-default-export */

export async function floodFill6({
  segImageUri,
  colorImageUri,
  x,
  y,
  color,
  uInt32Color,
  // range,
}) {
  // console.log('lineImage for floodFill6: ', segImageUri);
  return new Promise(async (resolve, reject) => {
    if (!segImageUri || !colorImageUri) {
      reject(new Error('Line image or color image is null.')); return;
    }
    if (typeof x !== 'number' || typeof y !== 'number') {
      reject(new Error('X or y is not a number.')); return;
    }
    if (!Array.isArray(color) || color.length !== 4) {
      reject(new Error('Color must be an rgba array in range [0..255]')); return;
    }
    let width;
    let height;
    try {
      const {
        width: segImgWidth,
        height: segImgHeight,
      } = await getImageDimensions(segImageUri);
      const {
        width: colorImgWidth,
        height: colorImgHeight,
      } = await getImageDimensions(colorImageUri);
      if (segImgWidth !== colorImgWidth || segImgHeight !== colorImgHeight) {
        reject(new Error('Cannot flood fill image. Image dimensions of line and color images are different'));
        return;
      }
      width = segImgWidth;
      height = segImgHeight;
      // console.log(width, height);
    } catch (err) { reject(err); return; }
    const { canvas, ctx } = createCanvas({ width, height });
    const colorImgEl = await loadImage(colorImageUri);
    ctx.drawImage(colorImgEl, 0, 0);
    const segImageEl = await loadImage(segImageUri);
    const { ctx: ctx2 } = createCanvas({ width, height });
    ctx2.drawImage(segImageEl, 0, 0);

    // connvert color image to pixel data obj
    const segImgImageData = ctx2.getImageData(0, 0, ctx2.canvas.width, ctx2.canvas.height);
    const segImgPixelData = {
      width: segImgImageData.width,
      height: segImgImageData.height,
      data: new Uint32Array(segImgImageData.data.buffer),
    };
    // console.log(segImgPixelData.data.length);
    let combinedColor = uInt32Color;
    if (!uInt32Color) {
      combinedColor = rgbaArrayToUint32(color);
    }
    // const randomColor = (0x1000000+(Math.random())*0xffffff).toString(16).substr(1,6);
    // console.log('randomColor: ', randomColor);

    /* eslint-disable no-use-before-define */
    await floodFill(ctx, x, y, combinedColor, segImgPixelData);
    // console.log('floodfill complete');
    resolve(canvas.toDataURL('image/png', 1.0));
  });
}

function getPixel(pixelData, x, y) {
  if (x < 0 || y < 0 || x >= pixelData.width || y >= pixelData.height) {
    return -1; // impossible color
  }
  return pixelData.data[y * pixelData.width + x];
}

function floodFill(ctx, xStart, yStart, fillColor, segImgPixelData) {
  // console.log('floodFill called');
  const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  // console.log('fillColor: ', fillColor);
  // color image pixel data to update (isn't analyzed, just altered)
  const pixelData = {
    width: imageData.width,
    height: imageData.height,
    data: new Uint32Array(imageData.data.buffer),
  };
  // get the sampled color to change:
  const targetColor = getPixel(segImgPixelData, xStart, yStart);
  // const targetColor = getPixel(pixelData, xStart, yStart);
  // console. log('targetColor: ', targetColor);
  // eventually make this next line better so we can expand a currently filled area
  // if (targetColor === fillColor) {
  //   console.log('target color = fill color');
  // return; }
  const { width, height } = pixelData;

  // --------------------------------------------------------------------------------->>
  // put new functions here from
  // http://will.thimbleby.net/scanline-flood-fill/
  // let pixelPos = (y * width + x);

  // xMin,   xMax,   y,   (down[true] or up[false]),   extendLeft,   extendRight
  pixelData.data[(yStart * width + xStart)] = fillColor;
  // paint(x, y, pixelData.data);
  const ranges = [[xStart, xStart, yStart, null, true, true]];

  while (ranges.length) {
    /*
    setTimeout(() => {
      console.log('timeout');
    }, 100);
    */
    // let pixelPos = (y);
    const r = ranges.pop(); // remove last element
    const down = r[3] === true; // if r[3] is true, down is true
    // console.log('down: ', down);
    const up = r[3] === false;
    // console.log('ranges.length: ', ranges.length);

    // extendLeft
    let minX = r[0];
    const y = r[2];
    if (r[4]) {
      // while left neighbor is also the target color
      /* eslint-disable-next-line */
      while (minX > 0 && getPixel(segImgPixelData, minX - 1, y) === targetColor) {
        minX -= 1; // move one step left
        // paint
        // console.log('paint left: ', minX, ', ', y);
        pixelData.data[(y * width + minX)] = fillColor;
        /* eslint-disable */
        segImgPixelData.data[(y * width + minX)] = fillColor;
        // reassigning a passed param is not encouraged,
        // but in this case it is ok since we don't need
        // the data after this function returns. we temporarily
        // redefine segmap data to avoid an infinite loop
      }
    }
    let maxX = r[1];
    // extendRight
    if (r[5]) {
      /* eslint-disable-next-line */
      while (maxX < width - 1 && getPixel(segImgPixelData, maxX + 1, y) === targetColor) {
        maxX += 1;
        // paint
        // console.log('paint right: ', maxX, ', ', y);
        pixelData.data[(y * width + maxX)] = fillColor;
        /* eslint-disable */
        segImgPixelData.data[(y * width + maxX)] = fillColor;
      }
    }

    r[0] -= 1;
    r[1] += 1;

    function addNextLine(newY, isNext, downwards) {
      // console.log('y = ', newY);
      let rMinX = minX;
      let inRange = false;
      let x = 0;
      for (x = minX; x <= maxX; x += 1) {
        // skip testing, if testing previous line within previous range
        const empty = (
          isNext || (x < r[0] || x > r[1]))
          && getPixel(segImgPixelData, x, newY) === targetColor;
        if (!inRange && empty) {
          rMinX = x;
          inRange = true;
        } else if (inRange && !empty) {
          ranges.push([rMinX, x - 1, newY, downwards, rMinX === minX, false]);
          inRange = false;
        }
        if (inRange) {
          // console.log('paint inrange right: ', x, ', ', newY);
          // paint
          pixelData.data[(newY * width + x)] = fillColor;
          /* eslint-disable */
          segImgPixelData.data[(newY * width + x)] = fillColor;
        }
        // skip
        if (!isNext && x === r[0]) {
          x = r[1];
        }
      }
      if (inRange) {
        ranges.push([rMinX, x - 1, newY, downwards, rMinX === minX, true]);
      }
    }

    if (y < height) {
      // console.log('add line down');
      addNextLine(y + 1, !up, true);
    }
    if (y > 0) {
      // console.log('add line up');
      addNextLine(y - 1, !down, false);
    }
  }

  // end new functions
  // --------------------------------------------------------------------------------->>

  // pixelsToFill.forEach(item => pixelData.data[item] = fillColor);
  // put the data back
  ctx.putImageData(imageData, 0, 0);
  // pixelsToFill = [];
}
