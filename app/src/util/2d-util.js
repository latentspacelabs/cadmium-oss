/**
 * @typedef Point2D
 * @property {number} x
 * @property {number} y
*/

/**
 * Interpolates between two points
 *
 * @param {Point2D} p1
 * @param {Point2D} p2
 * @param {number} amount
 * @returns {Point2D}
 */
// export function lerp2d(p1, p2, amount) {
//   return {
//     x: p1.x + (p2.x - p1.x) * amount,
//     y: p1.y + (p2.y - p1.y) * amount,
//   };
// }

/**
 * Calculates the distance between two points
 * @param {Point2D} p1
 * @param {Point2D} p2
 * @returns {number}
 */
export function distanceBetween(p1, p2) {
  return Math.sqrt(((p2.x - p1.x) ** 2) + ((p2.y - p1.y) ** 2));
}

/**
 * Calculates the angle between two points
 * @param {Point2D} p1
 * @param {Point2D} p2
 * @returns {number}
 */
export function angleBetween(p1, p2) {
  return Math.atan2(p2.x - p1.x, p2.y - p1.y);
}
