/* eslint-disable linebreak-style */
export default class UndoRedoItem {
  /**
   * A single undo/redo step. Phase 6a stores inverse PATCHES (see
   * services/state-patch.js) instead of a whole-state clone: one item carries
   * both directions, so undo applies `undoPatch` and redo applies `redoPatch`.
   *
   * @param {Object} options
   * @param {Array} options.undoPatch - ops that revert the change (after -> before)
   * @param {Array} options.redoPatch - ops that re-apply the change (before -> after)
   * @param {string} options.name - Name of the undoable action
   * @param {string} [options.readableName] - Human-readable name (e.g. for a menu)
   * @param {string} [options.type] - Kind of item, e.g. 'action'
   */
  constructor({
    undoPatch,
    redoPatch,
    name,
    readableName,
    type,
  }) {
    this.undoPatch = undoPatch;
    this.redoPatch = redoPatch;
    this.name = name;
    this.readableName = readableName || name;
    this.type = type;
  }
}
