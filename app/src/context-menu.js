import store from '@/store';
import { logError } from '@/util/error-util';

import { TOGGLE_FRAME_ORIGINALITY } from '@/store/action-types';

import { i18n } from './util/i18nVue';
import { createMenu, createMenuItem } from '@/platform';

let context = {
  name: null, // the clicked element, e.g. 'frame'
};

const contextMenuItemIds = {
  CONVERT_TO_REFERENCE_FRAME: 'CONVERT_TO_REFERENCE_FRAME',
};

export const frameContextMenu = createMenu();

frameContextMenu.append(createMenuItem({
  label: i18n.__('Reference Frame'),
  id: contextMenuItemIds.CONVERT_TO_REFERENCE_FRAME,
  enabled: true,
  visible: true,
  type: 'checkbox',
  checked: false,
  click() {
    if (!context || !context.frameNr || !context.layerId) {
      logError(new Error('Could not convert frame to reference frame. Context not set. You need to call setContextMenuContext first, passing { frameNr, layerId }'));
      return;
    }
    // One ACTION so the undo plugin can put a boundary around the whole
    // toggle (per-dupe SET_FRAME_ORIGINAL commits + originality correction).
    store.dispatch(TOGGLE_FRAME_ORIGINALITY, {
      layerId: context.layerId,
      frameNr: context.frameNr,
      isOriginal: !context.isOriginal,
    });
  },
}));

export function setContextMenuContext(ctx) {
  context = { ...ctx };
  // context specific changes in the menu when frame is right clicked
  if (context.name === 'frame') {
    // change the checked state of the checkbox to reflect the frame state
    if (typeof context.isOriginal !== 'undefined') {
      /* eslint-disable max-len */
      const refFrameMenuItem = frameContextMenu.getMenuItemById(contextMenuItemIds.CONVERT_TO_REFERENCE_FRAME);
      refFrameMenuItem.checked = context.isOriginal;
    }
  }
}
