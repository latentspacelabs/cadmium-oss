<!-- eslint-disable linebreak-style -->
<template>
    <div
      class="color-palette-circle color-swatches"
      :key="color.hex"
      v-bind:class="{ hasContrastRing: swatchNeedsContrastRing}"
      v-bind:style="{ backgroundColor: this.color }"
      draggable="false"
    >
    </div>
</template> <!-- eslint-disable linebreak-style -->
<!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */

import {
  hexToRgbArray,
} from '@/util/color-util';

// const contrast = require('get-contrast');

export default {
  data() {
    return {};
  },
  props: {
    color: {
      type: String,
      required: true,
    },
    flash: {
      type: Boolean,
      required: false,
    },
  },
  computed: {

    swatchNeedsContrastRing() {
      // const swatchContrastScore = contrast.ratio(this.color, '#303133');
      // console.log('Swatch contrast score', swatchContrastScore);
      let contrastRingResult = false;
      const color1 = hexToRgbArray(this.color);
      const color2 = hexToRgbArray('#303133');
      // console.log ('color1 r: ', color1[0]);
      const rgbCompare = 45;
      const colorDiff = (
        Math.abs(color1[0] - color2[0])
        + Math.abs(color1[1] - color2[1])
        + Math.abs(color1[2] - color2[2])
      );
      // console.log('colorDiff: ', colorDiff);
      // if (swatchContrastScore < 2) {
      if (colorDiff < rgbCompare) {
        contrastRingResult = true;
      }
      // }
      return contrastRingResult;
    },
  },
  methods: {
    onClick() {
      // this.$emit('click');
    },
  },
};
</script>

<style lang="scss">

.hasContrastRing {
  border-style: solid;
  border-color: #505050;
  border-width: 1px;
}

.flashStyle{
  animation: blinkingBackground 1.2s infinite;
}
@keyframes blinkingBackground{
  0% {
    border-style: solid;
    border-radius: 6px;
    border-color: #313131;
    border-width: 1px;
    // filter: brightness(100%);
  }
  25% {
    border-style: solid;
    border-radius: 16px;
    border-color: #9834d3;
    border-width: 2px;
    // filter: brightness(50%);
  }
  50% {
    border-style: solid;
    border-radius: 6px;
    border-color: #6e22c8;
    border-width: 1px;
    // filter: brightness(100%);
  }
  75% {
    border-style: solid;
    border-radius: 16px;
    border-color: #9834d3;
    border-width: 2px;
    // filter: brightness(50%);
  }
  100% {
    border-style: solid;
    border-radius: 6px;
    border-color: #313131;
    border-width: 1px;
    // filter: brightness(100%);
  }
}

</style>
