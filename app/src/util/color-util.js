/**
 *
 * @param {number} colorComponent - int in range [0..255]
 * @param {boolean} [uppercase=false]
 * @returns {string} - zero padded hex representation, e.g. '0a'.
 */
// export function intColorComponentToHexString(colorComponent, uppercase) {
//   let ret;
//   if (typeof colorComponent !== 'number') {
//     ret = '00';
//   }
//   ret = colorComponent.toString(16);
//   if (ret.length === 1) { ret = '0' + ret; }
//   if (uppercase) { ret = ret.toUpperCase(); }
//   return ret;
// }

/**
 * Converts an array of int values e.g. [255, 0, 0, 255] (r, g, b, a)
 * to Hex representation (same as used in Uint32Array): 0xFF0000FF
 * @param {Array} rgbaArr - RGBA-Array, e.g. [255, 0, 0, 255]
 * @returns {Number} - Combination of all color components in one number (rrggbbaa), e.g. 0xFF0000FF
 */
export function rgbaArrayToUint32(rgbaArr) {
  if (!Array.isArray(rgbaArr)) { console.error('Param is null.'); return null; }
  if (!rgbaArr === 4) { console.error('Array length must be 4 (r, g, b, a).'); return null; }
  let hexStr = '';
  rgbaArr.forEach((n) => {
    let hex = n.toString(16);
    if (hex.length === 1) { hex = `0${hex}`; }
    hexStr = hex + hexStr; // order??
  });
  return parseInt(hexStr, 16);
}

export function greyScaleNumToUint32(greyScaleNum) {
  if (!Number.isInteger(greyScaleNum)) {
    console.error('Param is null.');
    return null;
  }
  if ((greyScaleNum < 0) || (greyScaleNum > 255)) {
    console.error('Number must have value of 0 - 255.');
    return null;
  }
  const greyToRGB = [greyScaleNum, greyScaleNum, greyScaleNum, 255];
  let hexStr = '';
  greyToRGB.forEach((n) => {
    let hex = n.toString(16);
    if (hex.length === 1) { hex = `0${hex}`; }
    hexStr = hex + hexStr; // order??
  });
  return parseInt(hexStr, 16);
}

/**
 * Converts an array of int values e.g. [255, 0, 0, 255] (r, g, b, a)
 * to Hex representation as string: 'FF0000FF'
 * @param {Array} rgbaArr
 *   RGBA-Array, e.g. [255, 0, 0, 255]
 * @param {Object} [options]
 * @param {boolean} [options.useHashSymbol=true]
 *   Add a has symbol as first character, e.g. '#FF000011'
 * @param {boolean} [options.useAlpha=true]
 *   Includes the alpha value, e.g. '#FF000011'
 * @returns {String}
 *   Combination of all color components as hex string (#rrggbbaa), e.g. '#FF0000FF'
 */
export function rgbaArrayToHex(rgbaArr, { useHashSymbol = true, useAlpha = true } = {}) {
  // Check if array has correct size
  // We cannot use Array.isArray here, because for typed arrays this would return false
  if (!rgbaArr || !rgbaArr.length || rgbaArr.length !== 4) { console.error('Param is null.'); return null; }
  if (!rgbaArr === 4) { console.error('Array length must be 4 (r, g, b, a).'); return null; }
  let hexStr = '';
  rgbaArr.forEach((n, i) => {
    if (i < 3 || useAlpha) {
      let hex = n.toString(16);
      if (hex.length === 1) { hex = `0${hex}`; }
      hexStr += hex; // order??
    }
  });
  if (useHashSymbol) { hexStr = `#${hexStr}`; }
  return hexStr;
}

/**
 * Converts a hex color (e.g. '#FF0000') into an int-array, e.g. [255, 0, 0]
 * @param {string} hexColor - Hex color in the format "#RRGGBB"
 */
export function hexToRgbArray(hexColor) {
  if (!hexColor || !hexColor.length || !hexColor.length === 7) {
    console.log(hexColor);
    throw new Error('Bad arguments. Expected hex color with 7 characters (#RRGGBB)');
  }
  return [
    parseInt(hexColor.substring(1, 3), 16),
    parseInt(hexColor.substring(3, 5), 16),
    parseInt(hexColor.substring(5, 7), 16),
  ];
}

export function hexToRgbObject(hexColor) {
  if (!hexColor || !hexColor.length || !hexColor.length === 7) {
    throw new Error('Bad arguments. Expected hex color with 7 characters (#RRGGBB)');
  }
  return {
    r: parseInt(hexColor.substring(1, 3), 16),
    g: parseInt(hexColor.substring(3, 5), 16),
    b: parseInt(hexColor.substring(5, 7), 16),
    a: 255,
  };
}

/**
 * Returns a contrasting color, either white or black as hex color.
 * Depends on the color of c.
 * @param {string} c - Hex color, e.g. '#ff0000'
 * @returns {string} - Either black "#000000" or white '#ffffff'
 */
export function getContrastBWColor(c) {
  if (!c || !c.length || !c.length === 7) {
    throw new Error('Expected hex color, e.g. #ff0000');
  }
  const a = [
    parseInt(c.substring(1, 3), 16),
    parseInt(c.substring(3, 5), 16),
    parseInt(c.substring(5, 7), 16),
  ];

  const avg = (a[0] + a[1] + a[2]) / 3;
  const threshold = 127;
  if (avg > threshold) {
    return '#000000';
  }
  return '#ffffff';
}

export function uInt32Opaque(c) {
  // new better function to find alpha val
  // [r, g*256^1, b * 256 ^2, a * 256 ^3] these values added is a uint32 num
  const colorNoAlpha = c % (2 ** 24);
  /*
  const colorRG = colorNoAlpha % (2 ** 16);
  const colorR = colorRG % (2 ** 8);
  const colorG = (colorRG - colorR) / (2 ** 8);
  const colorB = (colorNoAlpha - colorRG) / (2 ** 16);
  */
  const alphaVal = (c - colorNoAlpha) / (2 ** 24);
  const d = c + (255 - alphaVal) * (2 ** 24);

  return d;
}
