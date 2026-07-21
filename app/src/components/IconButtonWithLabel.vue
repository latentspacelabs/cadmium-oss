<template>
  <div
    class="icon-button-with-label"
    @click="onItemClick"
    @dragstart.prevent="/* this makes sure that the icon cannot be dragged */"
  >
    <img class="icon-button-with-label__icon" :src="icon">
    <div class="icon-button-with-label__text">{{ title }}</div>
  </div>
</template>

<script>
export default {
  props: {
    title: {
      type: String,
      required: true,
    },
    icon: {
      type: String,
    },
    command: {
      type: String,
    },
  },
  methods: {
    onItemClick() {
      this.$emit('click');
    },
  },
};
</script>

<style lang="scss">
.icon-button-with-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;

  &:hover {
    opacity: 0.8;
  }
}
.icon-button-with-label__icon {
  margin-bottom: 4px;
}
.icon-button-with-label__text {
    color: white;
    font-size: 11px;
}
</style>
