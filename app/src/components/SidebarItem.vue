<template>
  <div
    class="sidebar-item"
    :class="{
      'sidebar-item--is-pressed': isPressed,
      'sidebar-item--is-deactivated': isDeactivated,
      'sidebar-item--is-highlighted': isHighlighted,
      'sidebar-item--is-color-wheel': isColorWheel,
    }"
    @click="onClick"
    @dragstart.prevent="/* this makes sure that the icon cannot be dragged */"
  >
    <img
      v-if="!isColorWheel"
      class="sidebar-item__icon"
      :src="iconUrl"
      alt=""
    >
    <div
      v-if="isColorWheel"
      class="sidebar-item__color-wheel-circle"
      :style="{
        // border: '1px solid white',
        border: '2px solid'+ reservedColor,
        // backgroundColor: reservedColor,
      }"
    >
      <div
        class="sidebar-item__color-wheel-inner-circle"
        :style="{
          // border: '2px solid #282828',
          backgroundColor: selectedColor,
        }"
      ></div>
    </div>
  </div>
</template>

<script>
import { mapGetters } from 'vuex';

import {
  SELECTED_COLOR,
  RESERVED_COLOR,
} from '@/store/getter-types';

export default {
  props: {
    iconUrl: {
      type: String,
      required: false,
      default: '',
    },
    isPressed: {
      type: Boolean,
      required: false,
      default: false,
    },
    isColorWheel: {
      type: Boolean,
      required: false,
      default: false,
    },
    isHighlighted: {
      type: Boolean,
      required: false,
      default: false,
    },
    isDeactivated: {
      type: Boolean,
      required: false,
      default: false,
    },
  },
  computed: {
    ...mapGetters({
      selectedColor: SELECTED_COLOR,
      reservedColor: RESERVED_COLOR,
    }),
  },
  methods: {
    onClick() {
      if (this.isDeactivated) { return; }
      this.$emit('click');
    },
  },
};
</script>

<style lang="scss">
.sidebar-item {
  width: 38px;
  height: 38px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  outline-width: 0px;
  // outline-color: #2d2d2d;

  &:hover {
    background-color: #2d2d2d;
  }

  &--is-pressed {
    background-color: #2d2d2d;
  }

  &--is-deactivated {
    pointer-events: none;
    opacity: 0.6;
  }

  &--is-highlighted {
  }

  &--is-color-wheel {
    display: flex;
    justify-content: center;
    align-items: center;
  }

  & + & {
    margin-top: 8px;
  }
}

.sidebar-item__color-wheel-circle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  // transform: rotate(45deg);
  // border: 1px solid white;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sidebar-item__color-wheel-inner-circle {
  width: 22px;
  height: 22px;
  border-radius: 50%;

}

.sidebar-item__icon {
  height: 24px; // perfect for the used icon sey: Streamline Icons v3.0

  .sidebar-item--is-highlighted & {
    // filter to produce the color purple highlight color
    // generated with: https://codepen.io/sosuke/pen/Pjoqqp
    filter: invert(33%) sepia(91%) saturate(3768%) hue-rotate(257deg) brightness(87%) contrast(83%);
  }
}
</style>
