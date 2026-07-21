<template>
    <svg
      class="swatchEyeIcon"
      :style="{ stroke: this.color }"
      :class="{ eyeIconShow: !this.visible }"
      draggable="false"
      viewBox="0 -2 25 25"
    >
      <!-- eslint-disable-next-line  -->
      <path class="a" d="M19.52,8.29h0a22.21,22.21,0,0,1,4,3.71S18.35,18.5,12,18.5h0A10.49,10.49,0,0,1,9,18"
        transform="translate(0 -1.75)"/>
      <!-- eslint-disable-next-line  -->
      <path class="a" d="M4.47,15.7h0A22.46,22.46,0,0,1,.5,12S5.65,5.5,12,5.5h0a9.64,9.64,0,0,1,2.5.33"
        transform="translate(0 -1.75)"/>
      <path class="a" d="M8,12H8a4,4,0,0,1,4-4" transform="translate(0 -1.75)"/>
      <path class="a" d="M16,12h0a4,4,0,0,1-4,4" transform="translate(0 -1.75)"/>
      <path class="a" d="M21.75,2.25,2.25,21.75" transform="translate(0 -1.75)"/>
    </svg>
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
    visible: {
      type: Boolean,
      required: true,
    },
  },
  computed: {

  },
  methods: {
    onClick() {
      // this.$emit('click');
    },
  },
};
</script>

<style lang="scss">
  .OpacityGauge {
    border-style: solid;
  }
</style>
