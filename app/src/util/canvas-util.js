export function createCanvas({ width, height }) {
  if (width <= 0 || height <= 0) {
    console.log(`Could not create canvas. Bad arguments: width: ${width}, height: ${height}`);
  }
  // console.log('Crearting canvas with dimensions: ', width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  return { canvas, ctx };
}

/**
 * Returns a blank data URI filled with transparent black pixels.
 * @param {Object} params
 * @param {Number} params.width
 * @param {Number} params.height
 */
export function getBlankDataUri({ width, height }) {
  const { canvas } = createCanvas({ width, height });
  return canvas.toDataURL('image/png', 1.0);
}

export function getColorCanvasDataUri({ width, height }, color) {
  // const colorString = '"' + color + '"';
  // console.log('colorCanvas: ', color);
  const { canvas } = createCanvas({ width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png', 1.0);
}
