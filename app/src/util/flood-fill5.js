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

export async function floodFill5({
  lineImageUri,
  colorImageUri,
  x,
  y,
  color,
  range,
}) {
  // console.log('lineImage for floodFill5: ', lineImageUri);
  return new Promise(async (resolve, reject) => {
    if (!lineImageUri || !colorImageUri) {
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
        width: lineImgWidth,
        height: lineImgHeight,
      } = await getImageDimensions(lineImageUri);
      const {
        width: colorImgWidth,
        height: colorImgHeight,
      } = await getImageDimensions(colorImageUri);
      if (lineImgWidth !== colorImgWidth || lineImgHeight !== colorImgHeight) {
        reject(new Error('Cannot flood fill image. Image dimensions of line and color images are different'));
        return;
      }
      width = lineImgWidth;
      height = lineImgHeight;
      // console.log(width, height);
    } catch (err) { reject(err); return; }
    const { canvas, ctx } = createCanvas({ width, height });
    const colorImgEl = await loadImage(colorImageUri);
    ctx.drawImage(colorImgEl, 0, 0);
    const lineImgEl = await loadImage(lineImageUri);
    const { ctx: ctx2 } = createCanvas({ width, height });
    ctx2.drawImage(lineImgEl, 0, 0);

    // connvert line image to pixel data obj
    const lineImgImageData = ctx2.getImageData(0, 0, ctx2.canvas.width, ctx2.canvas.height);
    const lineImgPixelData = {
      width: lineImgImageData.width,
      height: lineImgImageData.height,
      data: new Uint32Array(lineImgImageData.data.buffer),
    };

    const combinedColor = rgbaArrayToUint32(color);
    // const randomColor = (0x1000000+(Math.random())*0xffffff).toString(16).substr(1,6);
    // console.log('randomColor: ', randomColor);

    /* eslint-disable no-use-before-define */
    floodFill(ctx, x, y, combinedColor, lineImgPixelData, range);
    resolve(canvas.toDataURL('image/png', 1.0));
  });
}

// function pixelColorRange() {}

function lineAlphaCheck(x, y, lineImgPixelData, range) {
  const currentLineColor = getPixel(lineImgPixelData, x, y);
  // console.log('currentLineColor: ', currentLineColor);
  if (currentLineColor === 0) {
    return false;
    // console.log('currentLineColor is = 0');
  }
  /* eslint-disable-next-line */
  const currentAlphaColor = Math.floor(((lineImgPixelData.data[y * lineImgPixelData.width + x]) + 16777215) / 16843009);
  // console.log('currentAlphaColor: ', currentAlphaColor);
  if (currentAlphaColor >= (range)) {
    // console.log('alpha >= range', currentAlphaColor);
    return true;
  }
  return false;
  // console.log('currentAlpha color < range');
}

function getPixel(pixelData, x, y) {
  if (x < 0 || y < 0 || x >= pixelData.width || y >= pixelData.height) {
    return -1; // impossible color
  }
  return pixelData.data[y * pixelData.width + x];
}

/**
 *
 * @param {*} ctx
 * @param {*} x
 * @param {*} y
 * @param {*} fillColor e.g. 0xFF00FFFF (casing should not matter, but uppercase works)
 * @param {*} lineImgPixelData
*/

/*
var delay = 0;
function paint(x, y, pixelData) {
  map[x][y] = 2;
  const pixelPos = (x * y) + x;
  setTimeout(function() pixelData.data[pixelPos] = fillColor;
  // pixelData.data[pixelPos] = fillColor;
  // drawCell(x, y);}, delay);
  delay += 1;
}
*/

function floodFill(ctx, xStart, yStart, fillColor, lineImgPixelData, range) {
  // console.log('floodFill called');
  const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  // console.log('fillColor: ', fillColor);
  const pixelData = {
    width: imageData.width,
    height: imageData.height,
    data: new Uint32Array(imageData.data.buffer),
  };
  // get the sampled color to change:
  const targetColor = getPixel(pixelData, xStart, yStart);
  // console. log('targetColor: ', targetColor);
  // eventually make this next line better so we can expand a currently filled area
  if (targetColor === fillColor) {
    // console.log('target color = fill color');
    return;
  }
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
    // let pixelPos = (y);
    const r = ranges.pop();
    const down = r[3] === true;
    const up = r[3] === false;
    // console.log('ranges.length: ', ranges.length);

    // extendLeft
    let minX = r[0];
    const y = r[2];
    if (r[4]) {
      /* eslint-disable-next-line */
      while (minX > 0 && getPixel(pixelData, minX - 1, y) === targetColor
        && !lineAlphaCheck(minX - 1, y, lineImgPixelData, range)) {
        minX -= 1;
        pixelData.data[(y * width + minX)] = fillColor;
      }
    }
    let maxX = r[1];
    // extendRight
    if (r[5]) {
      /* eslint-disable-next-line */
      while (maxX < width - 1 && getPixel(pixelData, maxX + 1, y) === targetColor
        && !lineAlphaCheck(maxX + 1, y, lineImgPixelData, range)) {
        maxX += 1;
        pixelData.data[(y * width + maxX)] = fillColor;
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
          && getPixel(pixelData, x, newY) === targetColor
          && !lineAlphaCheck(x, newY, lineImgPixelData, range);
        if (!inRange && empty) {
          rMinX = x;
          inRange = true;
        } else if (inRange && !empty) {
          ranges.push([rMinX, x - 1, newY, downwards, rMinX === minX, false]);
          inRange = false;
        }
        // console.log('inRange: ', inRange);
        if (inRange) {
          // paint
          pixelData.data[(newY * width + x)] = fillColor;
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
      addNextLine(y + 1, !up, true);
    }
    if (y > 0) {
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
