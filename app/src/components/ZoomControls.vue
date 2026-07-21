<template>
  <div class="zoom-controls">
    <two-state-toggle
      optionOneLabel="Zoom In"
      optionTwoLabel="Zoom Out"
      :optionOneId="zoomInModeId"
      :optionTwoId="zoomOutModeId"
      :selectedOptionId="mode"
      @click="onOptionClick"
    ></two-state-toggle>
  </div>
</template>

<script>
import { mapGetters } from 'vuex';

import {
  ZOOM_TOOL_MODE_IN,
  ZOOM_TOOL_MODE_OUT,
} from '@/store/modules/ZoomTool';

import {
  ZOOM_TOOL_MODE,
} from '@/store/getter-types';

import {
  SET_ZOOM_TOOL_MODE,
} from '@/store/mutation-types';

import TwoStateToggle from '@/components/TwoStateToggle.vue';

export default {
  data() {
    return {
      zoomInModeId: ZOOM_TOOL_MODE_IN,
      zoomOutModeId: ZOOM_TOOL_MODE_OUT,
    };
  },
  computed: {
    ...mapGetters({
      mode: ZOOM_TOOL_MODE,
    }),
  },
  methods: {
    onOptionClick(modeId) {
      console.log('modeId: ', modeId);
      this.$store.commit(SET_ZOOM_TOOL_MODE, modeId);
    },
  },
  components: {
    TwoStateToggle,
  },
};
</script>

<style lang="scss">

</style>
