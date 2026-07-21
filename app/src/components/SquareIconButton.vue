<template>
  <button class="square-icon-btn" @click="onClick" :content="btnContent"
      v-tippy="{ placement : 'top' }">
    <img :src="icon" class="square-icon-btn__icon">
  </button>
</template>

<script>

import { i18n } from '@/util/i18nVue';

export default {
  props: {
    icon: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      default: null,
    },
  },
  computed: {
    btnContent() { return this.content || i18n.__('Play/Pause (Return)'); },
  },
  methods: {
    onClick() {
      this.$emit('click');
    },
  },
};
</script>

<style lang="scss">
.square-icon-btn {
  background-color: #363636;
  outline: none;
  border: none;
  width: 29px;
  height: 29px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    opacity: 0.8;
  }
}

.square-icon-btn__icon {
  height: 14px;
}
</style>
