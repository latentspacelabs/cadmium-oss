<template>
    <div
    v-if="swatchHasChange"
    :style="{
      // position: 'absolute',
      color: this.hex,
    }"
    >
    •
    </div>
</template>

<script>
export default {
  data() {
    return {};
  },
  props: {
    hex: {
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
    newHex: {
      type: String,
      required: true,
    },
    newOpacity: {
      type: Number,
      required: true,
    },
    newVisible: {
      type: Boolean,
      required: true,
    },
  },
  computed: {
    swatchHasChange() {
      if (this.hex !== this.newHex
          || this.visible !== this.newVisible
          || this.opacity !== this.newOpacity) {
        return true;
      }
      return false;
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

</style>
