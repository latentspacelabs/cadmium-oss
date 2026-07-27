<!-- eslint-disable linebreak-style -->
<template>
  <nav class="nav-bar">
    <div class="nav-bar__logo-wrapper">
      <img class="nav-bar__logo" src="../assets/logo2L_notext.svg">
      <span class="cadmium_logo">{{ cadmiumTitle }}</span>
      <div class="nav-bar__text">
        <span class="nav-bar__version-number">{{ appVersionNumber }}</span>
      </div>
    </div>
    <div class="file-name-wrapper">
      <span class="file-name" v-bind:class="{ isUnsaved: unsavedChanges }">{{ fileName }} {{ timelineHasFrames ? `  /  ${canvasSize.width}×${canvasSize.height}` : "" }}</span>
    </div>
    <nav-bar-icons @open-server-settings="$emit('open-server-settings')"></nav-bar-icons>
  </nav>
</template> <!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */
/* eslint-disable import/no-extraneous-dependencies */

import { t } from '@/util/i18n';

import { mapGetters } from 'vuex';
import { getAppVersion } from '@/platform';
import NavBarIcons from '@/components/NavBarIcons.vue';

import {
  CURRENT_FILE,
  UNSAVED_CHANGES,
  TIMELINE_HAS_FRAMES,
  CANVAS_SIZE,
} from '@/store/getter-types';


export default {
  data() {
    return {
    };
  },
  computed: {
    cadmiumTitle() { return t('cadmium'); },
    betaText() { return t('beta'); },
    ...mapGetters({
      currentFile: CURRENT_FILE,
      unsavedChanges: UNSAVED_CHANGES,
      timelineHasFrames: TIMELINE_HAS_FRAMES,
      canvasSize: CANVAS_SIZE,
    }),
    fileName() {
      if (this.currentFile) {
        // eslint-disable-next-line
        return this.currentFile.replace(/^.*[\\\/]/, '');
      }
      return '';
    },
    appVersionNumber: () => getAppVersion(),
    // uses version from package.json
  },
  components: {
    NavBarIcons,
  },
};
</script>

<style lang="scss">
.nav-bar {
  height: var(--nav-bar-height);
  // height: 80px;
  z-index: 1; // display over canvas
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 11px;
  background-color: #393939;
}
.nav-bar__logo-wrapper {
  display: flex;
  align-items: center;
}
.nav-bar__text {
  margin-left: 10px;
  opacity: 0.5;
  margin-top: 10px;
  min-width:330px;
}
.nav-bar__logo {
  height: 35px;
}

.nav-bar__usage-text {
  margin-left: 40px;
}

.file-name {
  color: #606266;
  display: -webkit-box !important;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: break-word;
}

.file-name-wrapper {
  width: 100%;
  margin-left: 20px;
  margin-top: 10px;
}

.isUnsaved:before {
  content: "*";
}

.cadmium_logo {
  font-family: Mont;
  font-size: 39px;
  margin-top: 6px;
  margin-left:5px;
  min-width:200px;
}

</style>
