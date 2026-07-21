/* eslint-disable import/prefer-default-export */

/**
 * Extracts the last number from a filename, e.g. 'foo_004.png', '004.jpg' -> 4.
 * @param {string} filename Filename to extract the number from, e.g. 'foo_004.png'
 * @returns {number|null} - the number or null
 */
export const extractFrameNumberFromFilename = (filename) => {
  if (!filename) { return null; }
  const dotIndex = filename.lastIndexOf('.');
  if (!dotIndex) {
    console.error(`Filename ${filename} has no prefix.`);
    return null;
  }
  const prefix = filename.substring(0, dotIndex);
  let frameNr;
  try {
    /* eslint-disable prefer-destructuring */
    frameNr = +prefix.match(/\d+$/)[0]; // extract last number from string
    frameNr += 1;
  } catch (e) {
    console.error(e);
  }
  return frameNr;
};

/**
 * Left-pads a string or number, e.g. '4' -> '0004'
 * @param {string|number} s - the string / number to left pad
 * @param {number} digits - how many digits the outputs string should have
 */
export function leftPad(s, digits) {
  // console.log('s: ', s);
  if (s < 0 && typeof s === 'number') { console.error('leftPad: s is null'); return null; }
  let s2 = s;
  if (typeof s === 'number') { s2 = s.toString(); }
  return s2.padStart(digits, '0');
}
