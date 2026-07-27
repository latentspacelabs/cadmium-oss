<template>
    <transition name="image-import-in-progress-fade">
        <div
            v-if="colorizationInProgress || exportInProgress || updateColorsInProgress"
            class="image-import-in-progress-screen"
        >
            <div class="waiting-content">
                <!-- Simple spinner -->
                <div class="spinner"></div>

                <!-- Task information -->
                <div class="waiting-info">
                    <h3 class="waiting-title">{{ currentTaskText }}</h3>
                    <p class="waiting-subtitle">{{ progressText }}</p>

                    <!-- Simple progress bar -->
                    <div class="progress-bar">
                        <div
                            class="progress-fill"
                            :style="{ width: progressPercentage + '%' }"
                        ></div>
                    </div>

                    <div class="progress-text">
                        {{ progressPercentage }}% • {{ timeRemainingString }} {{ remainingText }}
                    </div>

                    <!-- Cancel button -->
                    <round-button
                      :text="cancelBtnText"
                      @click="onCancelButtonClick"
                      color="white-outline"
                      :disabled="colorizationCanceled && exportCanceled &&
                                 analyzeCanceled"
                      :style="{ marginTop: '24px' }"
                    ></round-button>
                </div>
            </div>
        </div>

    </transition>
</template>

<script>

import { t } from '@/util/i18n';

import { cancelModal } from '@/util/server-client';

import { mapGetters } from 'vuex';

import { cancelJob } from '@/services/job-runner';

import {
  LAST_SEGMENTATION_MAP_GENERATION_TIME,
  FILE_IMPORT_CANCELED_BY_USER,
  LAYER_TYPE_OF_FILES_TO_IMPORT,
  COLORIZATION_IN_PROGRESS,
  UPDATE_COLORS_IN_PROGRESS,
  UPDATE_COLORS_CANCELED_BY_USER,
  COLORIZATION_PROGRESS,
  UPDATED_COLORS_PROGRESS,
  EXPORT_IN_PROGRESS,
  EXPORT_PROGRESS,
  EXPORTING_COLORS_SEPARATELY,
  ANALYZE_MODE_ONLY,
  COLORIZATION_CANCELED_BY_USER,
  EXPORT_CANCELED_BY_USER,
  ANALYZE_CANCELED_BY_USER,
  ESTIMATED_COLORIZATION_AND_SEGMENTATION_TIME_IN_SEC,
  ESTIMATED_EXPORT_TIME_IN_SEC,
  CURRENT_PROCESSING_TASK,
  EST_TIME_REMAINING,
} from '@/store/getter-types';

import {
  TASK_SEGMENTATION_MAP_GENERATION,
  TASK_COLORIZATION,
  TASK_EXPORT,
  TASK_IMPORT_COLOR_NO_LINE,
  TASK_COLOR_UPDATE,
} from '@/store/general-types';

import RoundButton from '@/components/RoundButton.vue';

export default {
  data() {
    return {
      TASK_COLOR_UPDATE,
    };
  },
  computed: {
    ...mapGetters({
      lastSegmentationMapGenerationTime: LAST_SEGMENTATION_MAP_GENERATION_TIME,
      estimatedColorSegTime: ESTIMATED_COLORIZATION_AND_SEGMENTATION_TIME_IN_SEC,
      estimatedExportTime: ESTIMATED_EXPORT_TIME_IN_SEC,
      importCanceled: FILE_IMPORT_CANCELED_BY_USER,
      colorizationCanceled: COLORIZATION_CANCELED_BY_USER,
      exportCanceled: EXPORT_CANCELED_BY_USER,
      analyzeCanceled: ANALYZE_CANCELED_BY_USER,
      layerTypeOfImport: LAYER_TYPE_OF_FILES_TO_IMPORT,
      colorizationInProgress: COLORIZATION_IN_PROGRESS,
      updateColorsInProgress: UPDATE_COLORS_IN_PROGRESS,
      updateColorsCanceled: UPDATE_COLORS_CANCELED_BY_USER,
      colorizationProgress: COLORIZATION_PROGRESS,
      updatedColorsProgress: UPDATED_COLORS_PROGRESS,
      exportInProgress: EXPORT_IN_PROGRESS,
      exportProgress: EXPORT_PROGRESS,
      exportingColorsSeparately: EXPORTING_COLORS_SEPARATELY,
      currentTask: CURRENT_PROCESSING_TASK,
      analyzeModeOnly: ANALYZE_MODE_ONLY,
      estTimeRemaining: EST_TIME_REMAINING,
    }),
    numTotal() {
      if (this.currentTask === TASK_EXPORT) {
        return this.exportProgress.numTotal;
      }
      if (this.currentTask === TASK_COLOR_UPDATE) {
        return this.updatedColorsProgress.numTotal;
      }
      return this.colorizationProgress.numTotal;
    },
    numFinished() {
      if (this.currentTask === TASK_EXPORT) {
        return this.exportProgress.numFinished;
      }
      if (this.currentTask === TASK_COLOR_UPDATE) {
        return this.updatedColorsProgress.numFinished;
      }
      return this.colorizationProgress.numFinished;
    },
    cancelBtnText() {
      if (this.currentTask === TASK_EXPORT) {
        return this.exportCanceled ? t('Stopping Export...') : t('Stop');
      }
      if (this.currentTask === TASK_IMPORT_COLOR_NO_LINE) {
        return this.analyzeCanceled ? t('Stopping Color Import...') : t('Stop');
      }
      if (this.currentTask === TASK_COLOR_UPDATE) {
        return this.updateColorsCanceled ? t('Stopping Color Update...') : t('Stop');
      }
      return this.colorizationCanceled ? t('Stopping Colorization...') : t('Stop');
    },
    timeRemainingString() {
      let taskTime;
      if (this.currentTask === TASK_EXPORT) {
        taskTime = this.estimatedExportTime;
      } else if (this.currentTask === TASK_IMPORT_COLOR_NO_LINE) {
        taskTime = this.estTimeRemaining;
        if (taskTime > 90) {
          const estimatedTimeInMin = Math.round(taskTime / 60);
          return `${estimatedTimeInMin} min `;
        }
        return `${taskTime} sec`;
      } else if (this.currentTask === TASK_COLOR_UPDATE) {
        taskTime = this.estTimeRemaining;
        if (taskTime > 90) {
          const estimatedTimeInMin = Math.round(taskTime / 60);
          return `${estimatedTimeInMin} min `;
        }
        return `${taskTime} sec`;
      } else {
        taskTime = this.estimatedColorSegTime;
      }
      let estimatedTimeInSec = Math.round(taskTime);
      if (this.analyzeModeOnly && this.currentTask !== TASK_EXPORT) {
        estimatedTimeInSec = Math.round(taskTime / 2);
      }
      if (estimatedTimeInSec > 90) {
        const estimatedTimeInMin = Math.round(estimatedTimeInSec / 60);
        return `${estimatedTimeInMin} min `;
      }
      return `${estimatedTimeInSec} sec`;
    },
    currentTaskText() {
      switch (this.currentTask) {
        case TASK_COLORIZATION:
          return t('Colorizing Frame');
        case TASK_SEGMENTATION_MAP_GENERATION:
          return t('Analyzing Frame');
        case TASK_EXPORT:
          return this.exportingColorsSeparately
            ? t('Exporting Colors Separately')
            : t('Exporting Frame');
        case TASK_COLOR_UPDATE:
          return t('Updating Colors');
        case TASK_IMPORT_COLOR_NO_LINE:
          return t('Analyzing Frame');
        default:
          return '';
      }
    },
    progressText() {
      return `${this.processingFrameText} ${this.numFinished + 1} ${this.ofText} ${this.numTotal}`;
    },
    progressPercentage() {
      if (this.numTotal === 0) return 0;
      return Math.round(((this.numFinished) / this.numTotal) * 100);
    },
    remainingText() { return t('remaining'); },
    processingFrameText() {
      return t('Processing frame');
    },
    ofText() { return t('of'); },
  },
  methods: {
    onCancelButtonClick() {
      console.log('cancel btn clicked');
      // The JobRunner is the single writer of the cancellation state: it aborts
      // the in-flight job's AbortSignal AND commits the matching legacy
      // SET_*_CANCELED_BY_USER(true) mutation, so the existing mid-loop polls
      // still trip for whichever job is running.
      cancelJob(this.$store);
      cancelModal();
    },
  },
  components: {
    RoundButton,
  },
};
</script>

<style lang="scss">
.image-import-in-progress-screen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 100;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: rgba(38, 38, 38, 0.9);
}

.waiting-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 400px;
  padding: 32px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top: 3px solid #9834d3;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 24px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.waiting-info {
  width: 100%;
}

.waiting-title {
  font-size: 18px;
  font-weight: 500;
  color: white;
  margin: 0 0 8px 0;
}

.waiting-subtitle {
  font-size: 14px;
  color: #b0b0b0;
  margin: 0 0 24px 0;
}

.progress-bar {
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 12px;
}

.progress-fill {
  height: 100%;
  background: #9834d3;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 14px;
  color: #b0b0b0;
  margin-bottom: 24px;
}

.image-import-in-progress-fade-enter-active,
.image-import-in-progress-fade-leave-active {
  transition: opacity 0.3s ease;
}

.image-import-in-progress-fade-enter-from,
.image-import-in-progress-fade-leave-to {
  opacity: 0;
}

// Legacy Vue 2 transitions
.image-import-in-progress-fade-enter,
.image-import-in-progress-fade-leave-to {
  opacity: 0;
}
</style>
