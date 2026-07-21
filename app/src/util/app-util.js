/*
 * @returns {bool} `true` if the environment variable `NODE_ENV`
 * is `'production'`, `false` otherwise.
 * The environment variables are set in the `build` and `serve` scripts
 * in package.json.
 */
export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/*
 * @returns {bool} `true` if the environment variable `NODE_ENV`
 * is `'development'`, `false` otherwise.
 * The environment variables are set in the `build` and `serve` scripts
 * in package.json.
 */
export function isDevelopment() {
  return process.env.NODE_ENV === 'development';
}
