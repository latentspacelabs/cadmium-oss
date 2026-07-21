import store from '@/store';
// import { logError } from '@/util/error-util';

import { REMOVE_MULTIPLE_COLOR_SWATCHES } from '@/store/action-types';
import { createMenu, createMenuItem } from '@/platform';

export const swatchMenu = createMenu();

let color;

swatchMenu.append(createMenuItem({
  label: 'Remove Color',
  id: 'Remove Color',
  enabled: true,
  visible: true,
  click() {
    // Through the ACTION (not a raw commit) so the removal is undoable.
    store.dispatch(REMOVE_MULTIPLE_COLOR_SWATCHES, { colorsToDelete: [color] });
  },
}));

export function setSwatchMenuContext(index) {
  color = index;
}
