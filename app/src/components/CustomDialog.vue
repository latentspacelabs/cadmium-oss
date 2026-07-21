<template>
  <div v-if="visible" class="custom-dialog-overlay" @click="handleOverlayClick">
    <div class="custom-dialog" @click.stop>
      <div class="custom-dialog__header unselectable">
        <img class="custom-dialog__icon" :src="iconSrc" :alt="appNameAlt">
        <h3 class="custom-dialog__title">{{ title }}</h3>
      </div>

      <div class="custom-dialog__content unselectable">
        <p class="custom-dialog__message" v-html="message"></p>
        <p v-if="detail" class="custom-dialog__detail" v-html="detail"></p>
      </div>

      <div class="custom-dialog__buttons">
        <button
          v-for="(button, index) in buttons"
          :key="index"
          :class="[
            'custom-dialog__button',
            { 'custom-dialog__button--primary': index === defaultId },
            { 'custom-dialog__button--cancel': index === cancelId },
            { 'custom-dialog__button--loading': buttonLoadingStates[index] }
          ]"
          :disabled="buttonLoadingStates[index]"
          @click="handleButtonClick(index)"
        >
          <span v-if="buttonLoadingStates[index]" class="custom-dialog__button-spinner"></span>
          {{ button }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import { i18n } from '@/util/i18nVue';

export default {
  name: 'CustomDialog',
  props: {
    visible: {
      type: Boolean,
      default: false,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    detail: {
      type: String,
      default: '',
    },
    buttons: {
      type: Array,
      required: true,
    },
    defaultId: {
      type: Number,
      default: 0,
    },
    cancelId: {
      type: Number,
      default: -1,
    },
    type: {
      type: String,
      default: 'info',
      validator: (value) => ['info', 'warning', 'error', 'question'].includes(value),
    },
  },
  data() {
    return {
      buttonLoadingStates: {},
    };
  },
  watch: {
    buttons: {
      immediate: true,
      handler(newButtons) {
        // Initialize loading states for all buttons
        const loadingStates = {};
        newButtons.forEach((_, index) => {
          loadingStates[index] = false;
        });
        this.buttonLoadingStates = loadingStates;
      },
    },
  },
  computed: {
    appNameAlt() { return i18n.__('Cadmium'); },
    iconSrc() {
      // Use different Cadmium logos based on dialog type
      switch (this.type) {
        case 'error':
          // eslint-disable-next-line global-require
          return require('@/assets/logo2L_notext.svg'); // Dark logo for errors
        case 'warning':
          // eslint-disable-next-line global-require
          return require('@/assets/logo2F_notext.svg'); // Colored logo for warnings
        case 'info':
        default:
          // eslint-disable-next-line global-require
          return require('@/assets/logo2F_notext.svg'); // Default colored logo
      }
    },
  },
  methods: {
    handleButtonClick(index) {
      // Don't handle click if button is in loading state
      if (this.buttonLoadingStates[index]) {
        return;
      }
      this.$emit('button-click', { response: index });
    },
    handleOverlayClick() {
      // Close dialog when clicking overlay (if cancelId is set)
      if (this.cancelId >= 0) {
        this.handleButtonClick(this.cancelId);
      }
    },
    setButtonLoading(index, loading) {
      this.$set(this.buttonLoadingStates, index, loading);
    },
    closeDialog() {
      this.$emit('close');
    },
  },
};
</script>

<style lang="scss" scoped>
.custom-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.custom-dialog {
  background-color: #393939;
  border-radius: 8px;
  padding: 24px;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  border: 1px solid #555;
}

.custom-dialog__header {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
}

.custom-dialog__icon {
  width: 32px;
  height: 32px;
  margin-right: 12px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.custom-dialog__title {
  color: #ffffff;
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  font-family: 'Inter';
}

.custom-dialog__content {
  margin-bottom: 24px;
}

.custom-dialog__message {
  color: #e0e0e0;
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 8px 0;
  white-space: pre-line;
}

.custom-dialog__detail {
  color: #b0b0b0;
  font-size: 12px;
  line-height: 1.4;
  margin: 0;
  font-style: italic;
  white-space: pre-line;
}

.custom-dialog__buttons {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.custom-dialog__button {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 80px;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  &:active {
    transform: translateY(0);
  }
}

.custom-dialog__button--primary {
  background-color: #9834d3;
  color: white;

  &:hover {
    background-color: #8a2bc0;
  }
}

.custom-dialog__button--cancel {
  background-color: #555;
  color: #e0e0e0;

  &:hover {
    background-color: #666;
  }
}

.custom-dialog__button:not(.custom-dialog__button--primary):not(.custom-dialog__button--cancel) {
  background-color: #666;
  color: #e0e0e0;

  &:hover {
    background-color: #777;
  }
}

.custom-dialog__button--loading {
  opacity: 0.7;
  cursor: not-allowed !important;

  &:hover {
    transform: none !important;
    box-shadow: none !important;
  }
}

.custom-dialog__button-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: rgba(255, 255, 255, 0.8);
  animation: spin 1s ease-in-out infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.unselectable {
  user-select: none;
  -webkit-user-select: none;
  -ms-user-select: none;
  -moz-user-select: none;
}
</style>
