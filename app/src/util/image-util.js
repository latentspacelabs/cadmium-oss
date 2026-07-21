/* eslint-disable linebreak-style */
/* eslint-disable  */
import { createCanvas } from '@/util/canvas-util';
// eslint-disable-next-line

/**
 * @param {string} imageSrc - base64 image source (base64 image data with decoration / header)
 * @returns {object} - the image dimensions in the form { width: 123, height: 456 }
 */
export function getImageDimensions(imageSrc) {
  return new Promise((resolve) => {
    const i = new Image();
    i.onload = () => {
      resolve({ width: i.width, height: i.height });
    };
    i.src = imageSrc;
  });
}

/**
 * Loads an image and returns a RGBA representation (as Uint32Array)
 * of its pixel data (e.g. [0xFF0000FF, 0x00FF00FF] == [red, green]).
 * IMPORTANT: The byte order of the Uint32Array entries depends on the
 *   endienness of the host system!
 * @param {string} uri - The image source (e.g. base64 encoded data URI)
 * @returns {Promise} - The (loaded) HTML image element
 */
export async function getUint32ArrayFromImageUri(uri) {
  return new Promise(async (resolve, reject) => {
    if (!uri) { reject(new Error('Image URI is null!')); }
    /* eslint-disable no-use-before-define */
    const image = await loadImage(uri);
    const { canvas, ctx } = createCanvas({ width: image.width, height: image.height });
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    resolve(new Uint32Array(imageData.data.buffer));
  });
}

/**
 * Returns a RGBA representation (as Uint32Array)
 * of an image’s pixel data (e.g. [0xFF0000FF, 0x00FF00FF] == [red, green]).
 * IMPORTANT: The byte order of the Uint32Array entries depends on the
 *   endienness of the host system!
 * @param {Image} image - The image
 * @returns {Promise} - The (loaded) HTML image element
 */
export function getUint32ArrayFromImage(image) {
  return new Promise((resolve, reject) => {
    if (!image) { reject(new Error('Image is null!')); }
    const { canvas, ctx } = createCanvas({ width: image.width, height: image.height });
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    resolve(new Uint32Array(imageData.data.buffer));
  });
}

/**
 * Loads an image from src, creates an image element and returns it once the image is loaded.
 * @param {string} src - The image source (e.g. base64 encoded with decoration / header)
 * @returns {Promise} - The (loaded) HTML image element
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) { reject(new Error('Image source is null!')); }
    const img = new Image();
    img.addEventListener('load', () => { resolve(img); });
    img.addEventListener('error', (err) => { reject(err); });
    img.src = src;
  });
}

export async function checkForAlphaPixels(imgURI, width, height) {
  // console.log(width, height);
  let alphaCheck = false;
  const { canvas, ctx } = createCanvas({ width, height });
  const lineImg = await loadImage(imgURI);
  ctx.drawImage(lineImg, 0, 0);

  const lineImageCanvasData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  const pixelData = {
    width,
    height,
    data: new Uint32Array(lineImageCanvasData.data.buffer),
  };

  // LOOP THROUGH PIXELS and look for alpha
  let pixelCount = pixelData.data.length - 1;
  // console.log(pixelData.data);
  // console.log(pixelCount);
  // console.log('test pixel check: ', pixelData.data[pixelCount]);
  /* eslint-disable-next-line */
  await new Promise((resolve, reject) => {
    while (pixelCount >= 0) {
      // test to change empty pixels to purple
      const lineAlpha = Math.floor(((pixelData.data[pixelCount]) + 16777215) / 16843009);
      if (lineAlpha < 255) {
        alphaCheck = true;
        // console.log('found alpha pixel at ', pixelCount);
        break;
      }
      pixelCount -= 1;
    }
    // console.log('last pixel checked: ', pixelCount);
    resolve();
  });
  return(alphaCheck);
}
/*
export function computeColor(image) {
  // let computedImage = image;
  const pixelData = image.data;
  // const { height } = image;
  // const { width } = image;
  const palette = store.getters[COLOR_PALETTE];
  const paletteLength = palette.length;
  const deactivatedColors = [];
  const colorsWithOpacity = [];
  const computedColors = image.data;
  // let returnImage;
  // console.log('PIXELS: ', pixelData);
  // console.log('Palette Length', palette.length);
  for (let i = 0; i < paletteLength; i += 1) {
    // console.log('Palette item: ', palette[i]);
    if (palette[i].visible !== true) {
      const RGB = hexToRgbArray(palette[i].hex);
      deactivatedColors.push(RGB);
    }
    if (palette[i].opacity < 255) {
      colorsWithOpacity.push(i);
    }
  }
  // console.log('DEACTIVATED COLORS: ', deactivatedColors);
  // console.log('PIXEL DATA LENGTH', pixelData.length);
  const pixelDataLength = pixelData.length;
  for (let i = 0; i < pixelDataLength; i += 4) {
    const j = i;
    const k = i + 1;
    const l = i + 2;
    const rgb = [pixelData[j], pixelData[k], pixelData[l]];

    if (colorsWithOpacity.length >= 1){
      for (let j = 0; j < paletteLength; j += 1) {
        const swatchRGB = hexToRgbArray(palette[j].hex);
        if (
          (swatchRGB[0] === rgb[0])
          && (swatchRGB[1] === rgb[1])
          && (swatchRGB[2] === rgb[2])
        ) {
          const opacityOutput = i + 3;
          computedColors[opacityOutput] = palette[j].opacity;
        }
      }
    }

    if (deactivatedColors.length >= 1) {
      for (let v = 0; v < deactivatedColors.length; v += 1) {
        const deactivatedColor = deactivatedColors[v];
        for (let c = 0; c < 3; c += 1) {
          if (
            (deactivatedColor[0] === rgb[0])
            && (deactivatedColor[1] === rgb[1])
            && (deactivatedColor[2] === rgb[2])
          ) {
            const outputNum = i + 3;
            computedColors[outputNum] = 0;
          }
        }
      }
    }
  }
  // console.log('ComputedColors: ', computedColors);
  // console.log('Returned IMAGE DATA: ', image);
  return image;
}
*/
