<template>
  <input
    type="range"
    :min="min"
    :max="max"
    :step="step"
    v-model="currentValue"
    @input="onInput"
  />
</template>

<script>
export default {
  props: {
    value: {
      required: false,
      default: 0,
    },
    min: {
      required: false,
      default: 0,
    },
    max: {
      required: false,
      default: 1,
    },
    step: {
      required: false,
      default: 0.1,
    },
  },
  data() {
    return {
      currentValue: 0,
    };
  },
  methods: {
    onInput(ev) {
      console.log('Inputtt: ', ev.target.value);
      this.$emit('input', ev.target.value);
    },
  },
  mounted() { this.currentValue = this.value; },
  watch: {
    value(newValue) { // prop changed
      this.currentValue = newValue;
    },
  },
};
</script>

<style lang="scss">

</style>
