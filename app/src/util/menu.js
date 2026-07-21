// Utility for menu-related actions

import { rebuildMenu } from '@/platform';

function triggerMenuRebuildWithColorizationState(colorizationInProgress) {
  rebuildMenu(colorizationInProgress);
}

export default triggerMenuRebuildWithColorizationState;
