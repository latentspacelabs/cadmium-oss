/* eslint-disable linebreak-style */
export default class UndoRedoStack {
  /**
   *
   * @param {Object} store - Vuex store
   * @param {number} size - How many undo / redo steps
   */
  constructor(store, size) {
    this.store = store;
    this.size = size;
    this.undoStack = [];
    this.redoStack = [];
  }

  addUndoItem(undoRedoItem) {
    // eslint-disable-next-line
    if (!undoRedoItem instanceof UndoRedoStack) {
      // console.warn('Could not add undo item: ', undoRedoItem);
      return;
    }
    if (this.undoStack.length >= this.size) { this.undoStack.shift(); }
    this.undoStack.push(undoRedoItem);
    // console.log('Added to Undo Stack: ', undoRedoItem);
    // console.log('New Undo STACK: ', this.undoStack);
    // console.log('New Redo STACK: ', this.redoStack);
  }

  addRedoItem(undoRedoItem) {
    // eslint-disable-next-line
    if (!undoRedoItem instanceof UndoRedoStack) {
      // console.warn('Could not add redo item: ', undoRedoItem);
      return;
    }
    if (this.redoStack.length >= this.size) { this.redoStack.shift(); }
    this.redoStack.push(undoRedoItem);
    // console.log('Added to Redo Stack: ', undoRedoItem);
    // console.log('New Undo STACK: ', this.undoStack);
    // console.log('New Redo STACK: ', this.redoStack);
  }

  clearRedoStack() {
    this.redoStack = [];
  }

  clearUndoStack() {
    this.undoStack = [];
  }

  hasUndoItem() {
    return this.undoStack.length > 0;
  }

  hasRedoItem() {
    return this.redoStack.length > 0;
  }

  popUndoItem() {
    return this.undoStack.pop();
  }

  popRedoItem() {
    return this.redoStack.pop();
  }
}
