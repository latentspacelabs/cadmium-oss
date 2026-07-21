<template>
  <div
    class="three-state-toggle"
    :class="{ 'three-state-toggle_disabled': disabled }"
  >
    <div
      class="three-state-toggle__option three-state-toggle__option--one"
      :class="{ 'three-state-toggle__option--selected': optionOneSelected }"
      @click="onOptionOneClick"
    >
      <div class="three-state-toggle__label">{{ toggleOneText }}</div>
    </div>
    <div
      class="three-state-toggle__option three-state-toggle__option--two"
      :class="{ 'three-state-toggle__option--selected': optionTwoSelected }"
      @click="onOptionTwoClick"
    >
      <div class="three-state-toggle__label">{{ toggleTwoText }}</div>
    </div>
    <div
      class="three-state-toggle__option three-state-toggle__option--three"
      :class="{ 'three-state-toggle__option--selected': optionThreeSelected }"
      @click="onOptionThreeClick"
    >
      <div class="three-state-toggle__label">{{ toggleThreeText }}</div>
    </div>
  </div>
</template>

<script>

import { i18n } from '@/util/i18nVue';

export default {
  props: {
    optionOneLabel: {
      type: String,
      required: true,
    },
    optionOneId: {
      type: String,
      required: true,
    },
    optionTwoLabel: {
      type: String,
      required: true,
    },
    optionTwoId: {
      type: String,
      required: true,
    },
    optionThreeLabel: {
      type: String,
      required: true,
    },
    optionThreeId: {
      type: String,
      required: true,
    },
    selectedOptionId: {
      type: String,
      required: true,
    },
    disabled: {
      type: Boolean,
      required: false,
    },
  },
  computed: {
    toggleOneText() { return i18n.__(this.optionOneLabel); },
    toggleTwoText() { return i18n.__(this.optionTwoLabel); },
    toggleThreeText() { return i18n.__(this.optionThreeLabel); },
    optionOneSelected() {
      return this.selectedOptionId === this.optionOneId;
    },
    optionTwoSelected() {
      return this.selectedOptionId === this.optionTwoId;
    },
    optionThreeSelected() {
      return this.selectedOptionId === this.optionThreeId;
    },
  },
  methods: {
    onOptionOneClick() {
      this.$emit('click', this.optionOneId);
    },
    onOptionTwoClick() {
      this.$emit('click', this.optionTwoId);
    },
    onOptionThreeClick() {
      this.$emit('click', this.optionThreeId);
    },
  },
};
</script>

<style lang="scss">

  .three-state-toggle_disabled {
    opacity: .5;
  }

  .three-state-toggle {
    font-size: 13px;
    background-color: #4e4e4e;
    color: #858585;
    height: 29px;
    display: flex;
    text-transform: uppercase;
    --tst-border-radius: 29px;
    border-radius: var(--tst-border-radius);
  }

  .three-state-toggle__option {
    letter-spacing: 0.05em;
    width: 50%;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;

    &--one {
      border-radius: var(--tst-border-radius) 0 0 var(--tst-border-radius);
    }

    &--two {
      // border-radius: 0 var(--tst-border-radius) var(--tst-border-radius) 0;
    }
    &--three {
      border-radius: 0 var(--tst-border-radius) var(--tst-border-radius) 0;
    }

    &--selected {
      background-color: #9834d3;
      color: #e9e9e9;
    }
  }
  :focus {
    outline: 0;
  }
</style>
