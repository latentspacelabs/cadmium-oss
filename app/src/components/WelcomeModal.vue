<template>
  <div class="welcome-modal-overlay" v-if="isVisible" @click="closeModal">
    <div class="welcome-modal" @click.stop>
      <div class="welcome-modal__header">
        <h2>{{ t('Welcome to Cadmium!') }}</h2>
        <p>{{ t('Thanks for joining us! How would you like to get started?') }}</p>
      </div>

      <div class="welcome-modal__content">
        <div class="welcome-option" @click="takeTour">
          <div class="welcome-option__icon">
            <i class="icon-tour"></i>
          </div>
          <div class="welcome-option__content">
            <h3>{{ t('Take the Tour') }}</h3>
            <p>{{
              t(
                'Get a guided walkthrough of Cadmium\'s features and learn how to animate with AI.'
              )
            }}</p>
          </div>
        </div>

        <div class="welcome-option" @click="viewDocumentation">
          <div class="welcome-option__icon">
            <i class="icon-documentation"></i>
          </div>
          <div class="welcome-option__content">
            <h3>{{ t('View Documentation') }}</h3>
            <p>{{ t('Browse our documentation at your own pace.') }}</p>
          </div>
        </div>

        <div class="welcome-option" @click="loadSampleProject">
          <div class="welcome-option__icon">
            <i class="icon-sample"></i>
          </div>
          <div class="welcome-option__content">
            <h3>{{ t('Load Sample Project') }}</h3>
            <p>{{
              t('Start with a sample animation project to explore Cadmium\'s capabilities.')
            }}</p>
          </div>
        </div>
      </div>

      <div class="welcome-modal__footer">
        <button class="welcome-modal__skip" @click="skipWelcome">
          {{ t('Skip and start with empty project') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import { mapActions } from 'vuex';
import { t } from '@/util/i18n';
import {
  ADD_IMAGES_TO_TIMELINE,
  STORE_IMAGE_IN_IMAGE_STORE,
} from '@/store/action-types';
import { OPEN_FILE_FROM_OS } from '@/store/action-types';
import {
  INITIAL_LINE_LAYER_ID,
} from '@/store/general-types';
import { openExternal, setPref } from '@/platform';
const path = require('path');
const fs = require('fs');
const os = require('os');

export default {
  name: 'WelcomeModal',
  props: {
    isVisible: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      t,
    };
  },
  methods: {
    ...mapActions([
      ADD_IMAGES_TO_TIMELINE,
      STORE_IMAGE_IN_IMAGE_STORE,
      OPEN_FILE_FROM_OS,
    ]),

    closeModal() {
      this.$emit('close');
      this.markWelcomeCompleted();
    },

    skipWelcome() {
      this.closeModal();
    },

    takeTour() {
      this.closeModal();
      this.$emit('start-tour');
    },

    viewDocumentation() {
      // Open external documentation
      openExternal('https://github.com/latentspacelabs/cadmium-oss');
    },

    async loadSampleProject() {
      try {
        this.closeModal();
        const samplePath = this.getSampleProjectPath();
        if (!samplePath) {
          console.error('Sample project not found; falling back to generated frames');
          await this.createFallbackFrames();
          return;
        }
        await this[OPEN_FILE_FROM_OS]({ filePath: samplePath });
      } catch (e) {
        console.error('Failed to load sample project:', e);
        await this.createFallbackFrames();
      }
    },

    getSampleProjectPath() {
      try {
        const candidates = [];
        // Development paths
        candidates.push(path.join(process.cwd(), 'cadmium-app', 'src', 'assets', 'cdm', 'robot.cdm'));
        candidates.push(path.join(process.cwd(), 'src', 'assets', 'cdm', 'robot.cdm'));
        candidates.push(path.join(__dirname, '..', 'assets', 'cdm', 'robot.cdm'));
        candidates.push(path.join(__dirname, '..', '..', 'assets', 'cdm', 'robot.cdm'));
        // Packaged app paths
        if (process.resourcesPath) {
          candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'cdm', 'robot.cdm'));
          candidates.push(path.join(process.resourcesPath, 'app.asar', 'src', 'assets', 'cdm', 'robot.cdm'));
          candidates.push(path.join(process.resourcesPath, 'assets', 'cdm', 'robot.cdm'));
        }
        for (let i = 0; i < candidates.length; i += 1) {
          if (fs.existsSync(candidates[i])) {
            return candidates[i];
          }
        }
      } catch (e) {
        // ignore
      }
      return null;
    },

    async createSampleFrames() {
      try {
        // Create simple sample frames programmatically
        const sampleFrames = this.generateSampleFrameData();

        const robotDir = path.join(os.homedir(), 'Desktop', 'robot');
        
        // Check if directory exists
        if (!fs.existsSync(robotDir)) {
          console.error('Robot frames directory not found:', robotDir);
          // Fallback to generated frames
          await this.createFallbackFrames();
          return;
        }

        // Get all PNG files from the robot directory
        const files = fs.readdirSync(robotDir)
          .filter(file => file.toLowerCase().endsWith('.png'))
          .sort();

        if (files.length === 0) {
          console.error('No PNG files found in robot directory');
          await this.createFallbackFrames();
          return;
        }

        console.log(`Loading ${files.length} robot frames...`);

        // Convert files to File objects for the import system
        const fileLoadingQueue = await Promise.all(
          files.map(async (fileName) => {
            const filePath = path.join(robotDir, fileName);
            
            // Read file as base64 data URI
            const dataUri = await base64Encode(filePath, { asDataUri: true });
            
            // Convert data URI to blob
            const response = await fetch(dataUri);
            const blob = await response.blob();

            // Create file-like object
            return new File([blob], fileName, {
              type: 'image/png',
              lastModified: Date.now(),
            });
          })
        );

        // Use the existing import system
        await this[ADD_IMAGES_TO_TIMELINE]({
          layerId: INITIAL_LINE_LAYER_ID,
          fileLoadingQueue,
        });

        console.log('Robot frames loaded successfully');
      } catch (error) {
        console.error('Error loading robot frames:', error);
        // Fallback to generated frames if robot frames fail
        await this.createFallbackFrames();
      }
    },

    async createFallbackFrames() {
      try {
        // Generate 3 simple sample frames with basic line art as fallback
        const frames = [];
        const width = 400;
        const height = 300;

        for (let i = 0; i < 3; i += 1) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');

          // Clear with transparent background
          ctx.clearRect(0, 0, width, height);

          // Set drawing style
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          // Draw simple shapes that change across frames
          if (i === 0) {
            // Frame 1: Circle
            ctx.beginPath();
            ctx.arc(width / 2, height / 2, 50, 0, Math.PI * 2);
            ctx.stroke();
          } else if (i === 1) {
            // Frame 2: Square
            ctx.beginPath();
            ctx.rect(width / 2 - 50, height / 2 - 50, 100, 100);
            ctx.stroke();
          } else {
            // Frame 3: Triangle
            ctx.beginPath();
            ctx.moveTo(width / 2, height / 2 - 50);
            ctx.lineTo(width / 2 - 50, height / 2 + 50);
            ctx.lineTo(width / 2 + 50, height / 2 + 50);
            ctx.closePath();
            ctx.stroke();
          }

          // Convert to data URL
          const dataUrl = canvas.toDataURL('image/png');
          frames.push(dataUrl);
        }

        // Convert to file-like objects for the existing import system
        const filePromises = frames.map(async (frameDataUri, i) => {
          const fileName = `fallback_frame_${String(i + 1).padStart(3, '0')}.png`;

          // Convert data URI to blob
          const response = await fetch(frameDataUri);
          const blob = await response.blob();

          // Create file-like object
          return new File([blob], fileName, {
            type: 'image/png',
            lastModified: Date.now(),
          });
        });

        const fileLoadingQueue = await Promise.all(filePromises);

        // Use the existing import system
        await this[ADD_IMAGES_TO_TIMELINE]({
          layerId: INITIAL_LINE_LAYER_ID,
          fileLoadingQueue,
        });

        console.log('Fallback frames loaded successfully');
      } catch (error) {
        console.error('Error loading fallback frames:', error);
      }
    },

    markWelcomeCompleted() {
      // Mark that the user has seen the welcome modal
      setPref('welcomeModalShown', true);
    },
  },
};
</script>

<style lang="scss" scoped>
.welcome-modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.welcome-modal {
  background-color: #353535;
  color: #c5c5c5;
  border-radius: 8px;
  padding: 1.5rem;
  max-width: 520px;
  max-height: 70vh;
  overflow-y: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  margin: 1rem;
  border: 1px solid #4e4e4e;
}

.welcome-modal__header {
  text-align: center;
  margin-bottom: 2rem;

  h2 {
    margin: 0 0 1rem 0;
    font-size: 1.8rem;
    font-weight: 600;
    color: #ffffff;
  }

  p {
    margin: 0;
    color: #898989;
    font-size: 1rem;
  }
}

.welcome-modal__content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.welcome-option {
  display: flex;
  align-items: center;
  padding: 1rem;
  background: #3a3a3a;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid #4e4e4e;

  &:hover {
    background: #2d2d2d;
    border-color: #898989;
  }
}

.welcome-option__icon {
  margin-right: 1.5rem;
  font-size: 2.5rem;
  opacity: 0.8;
  min-width: 60px;
  text-align: center;

  .icon-tour::before {
    content: "🎯";
  }

  .icon-documentation::before {
    content: "📚";
  }

  .icon-sample::before {
    content: "🎨";
  }
}

.welcome-option__content {
  flex: 1;

  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.2rem;
    font-weight: 600;
    color: #ffffff;
  }

  p {
    margin: 0;
    color: #898989;
    line-height: 1.4;
    font-size: 0.9rem;
  }
}

.welcome-modal__footer {
  margin-top: 2rem;
  text-align: center;
}

.welcome-modal__skip {
  background: transparent;
  border: 1px solid #4e4e4e;
  color: #898989;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s ease;

  &:hover {
    background: #2d2d2d;
    border-color: #898989;
    color: #ffffff;
  }
}

// Responsive design
@media (max-width: 768px) {
  .welcome-modal {
    margin: 0.5rem;
    padding: 1.5rem;
  }

  .welcome-option {
    flex-direction: column;
    text-align: center;

    .welcome-option__icon {
      margin-right: 0;
      margin-bottom: 1rem;
    }
  }
}
</style>
