<template>
    <div
      class="swatchAperature"
      :style="{ borderColor: this.color, borderWidth: opacityGaugeValue }"
      draggable="false"
    >
    </div>
</template>

<script>
export default {
  data() {
    return {};
  },
  props: {
    color: {
      type: String,
      required: true,
    },
    opacity: {
      type: Number,
      required: true,
    },
    visible: {
      type: Boolean,
      required: true,
    },
    swatchOpacity: { alpha: 255 },
  },
  computed: {

    opacityGaugeValue() {
      const opacityNum = this.opacity;
      // console.log('OPACITY NUM: ', opacityNum);
      const mappedOpacity = this.mapRange(opacityNum, 0, 255, 1, 13);
      // Math.round(opacityNum / 19.6153);
      return `${mappedOpacity}px`;
    },
  },
  methods: {
    onClick() {
      // this.$emit('click');
    },
    mapRange(value, low1, high1, low2, high2) {
      return low2 + (high2 - low2) * (value - low1) / (high1 - low1);
    },
  },
};
</script>

<style lang="scss">

</style>
