<!-- eslint-disable linebreak-style -->
<template>
  <div
    class="round-button"
    :class="[
      `round-button--size-${size}`,
      `round-button--color-${color}`,
      disabled ? 'round-button--disabled' : '',
    ]"
    @click="onClick"
  >
    <div class="round-button__text">{{ buttonText }}</div>
  </div>
</template> <!-- eslint-disable linebreak-style -->
<script> /* eslint-disable linebreak-style */

import { t } from '@/util/i18n';

export default {
  data() {
    return {};
  },
  props: {
    text: {
      type: String,
      required: true,
    },
    size: {
      type: String,
      default: 'm',
    },
    color: {
      type: String,
      default: 'primary-outline',
    },
    disabled: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    buttonText() { return t(this.text); },
  },
  methods: {
    onClick() {
      this.$emit('click');
    },
  },
};
</script>

<style lang="scss">
.round-button {

  display: inline-flex;
  justify-content: center;
  align-items: center;
  text-transform: uppercase;
  line-height: 1;
  border-radius: 50%;
  user-select: none;
  cursor: pointer;

  &:hover {
    opacity: 0.8;
  }

  &--size-m {
    height: 46px;
    font-size: 15px;
    letter-spacing: 0.05em;
    border-radius: 30px;
    padding: 0 20px;
  }

  &--size-s {
    height: 46px;
    font-size: 10px !important;
    letter-spacing: 0.05em;
    border-radius: 30px;
    padding: 0 2px;
  }

  &--color-primary-outline {
    // border: 1px solid #B30EC3;
    background-image: linear-gradient(to right, #DA22FF 0%, #9733EE 51%, #DA22FF 100%);
    background-position: right center;

    &:hover {
      background-position: left center;
      opacity: 1;
    }

    & .round-button__text {
      color: white;
    }
  }

  &--color-white-outline {
    border: 1px solid white;

    & .round-button__text {
      color: white;
    }
  }

  &--disabled {
    opacity: 0.2;
    pointer-events: none;
  }
}
</style>
