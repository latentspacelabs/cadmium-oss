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

export async function floodFillArray({
  ctx,
  pixelData,
  xStart,
  yStart,
  targetColor,
}) {
  // console.log('floodFill called');
  // console. log('targetColor: ', targetColor);
  // console.log('pixelData: ', pixelData);
  const { width, height } = pixelData;
  const fillColor = rgbaArrayToUint32([30,200,111,255]); // some random non grey color
  const segPixels = [];

  // --------------------------------------------------------------------------------->>
  // put new functions here from
  // http://will.thimbleby.net/scanline-flood-fill/
  // let pixelPos = (y * width + x);

  // xMin,   xMax,   y,   (down[true] or up[false]),   extendLeft,   extendRight
  const startPoint = yStart * width + xStart;
  pixelData.data[startPoint] = fillColor;
  // console.log('fillColor: ', fillColor);
  // console.log('targetColor: ', targetColor);
  segPixels.push(startPoint);
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
      while (minX > 0 && getPixel(pixelData, minX - 1, y) === targetColor) {
        minX -= 1; // move one step left
        // paint
        // console.log('paint left: ', minX, ', ', y);
        pixelData.data[(y * width + minX)] = fillColor;
        segPixels.push(y * width + minX);
      }
    }
    let maxX = r[1];
    // extendRight
    if (r[5]) {
      /* eslint-disable-next-line */
      while (maxX < width - 1 && getPixel(pixelData, maxX + 1, y) === targetColor) {
        maxX += 1;
        // paint
        // console.log('paint right: ', maxX, ', ', y);
        pixelData.data[(y * width + maxX)] = fillColor;
        segPixels.push(y * width + maxX);
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
          && getPixel(pixelData, x, newY) === targetColor;
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
          segPixels.push(newY * width + x);
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
  // put the data back
  for (let i = 0; i < segPixels.length; i++) {
    pixelData.data[segPixels[i]] = targetColor;
  }

  return segPixels;
  // pixelsToFill = [];
}

function getPixel(pixelData, x, y) {
  if (x < 0 || y < 0 || x >= pixelData.width || y >= pixelData.height) {
    return -1; // impossible color
  }
  return pixelData.data[y * pixelData.width + x];
}
