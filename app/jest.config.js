// Unit-test config for the renderer. We defer to the official vue-cli jest
// preset (@vue/cli-plugin-unit-jest), which wires up the version-correct Vue
// SFC transformer (@vue/vue2-jest for this Vue 2.7 app), a jsdom environment,
// the `@/` -> `src/` alias, and jest-transform-stub for asset imports.
//
// The previous hand-rolled config referenced a bare `vue-jest` module that was
// never installed and ran in the `node` environment (no DOM), so `test:unit`
// could not start. Using the preset keeps this in lockstep with the toolchain.
module.exports = {
  preset: '@vue/cli-plugin-unit-jest',
};
