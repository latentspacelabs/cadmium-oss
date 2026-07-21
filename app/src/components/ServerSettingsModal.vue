<template>
  <div class="server-modal-overlay" v-if="isVisible" @click="onOverlayClick">
    <div class="server-modal" @click.stop>
      <div class="server-modal__header">
        <h2>{{ firstRun ? i18n.__('Connect to your Cadmium server') : i18n.__('Server Settings') }}</h2>
        <p>{{
          firstRun
            ? i18n.__('Cadmium needs a colorization server to run. Enter the URL of your server to get started.')
            : i18n.__('Colorize, analyze, and preprocess requests are sent to this backend.')
        }}</p>
      </div>

      <div class="server-modal__content">
        <label class="server-modal__label">{{ i18n.__('Backend') }}</label>
        <div class="server-modal__backends">
          <label
            class="server-modal__backend"
            :class="{ 'server-modal__backend--selected': kind === BACKEND_HOSTED }"
          >
            <input type="radio" :value="BACKEND_HOSTED" v-model="kind" />
            <span class="server-modal__backend-name">{{ i18n.__('Hosted server') }}</span>
            <span class="server-modal__backend-desc">
              {{ i18n.__('A server you run or can reach') }}
            </span>
          </label>
          <label
            class="server-modal__backend"
            :class="{ 'server-modal__backend--selected': kind === BACKEND_EMBEDDED }"
          >
            <input type="radio" :value="BACKEND_EMBEDDED" v-model="kind" />
            <span class="server-modal__backend-name">{{ i18n.__('Embedded (this computer)') }}</span>
            <span class="server-modal__backend-desc">
              {{ i18n.__('A local process the app manages') }}
            </span>
          </label>
        </div>

        <template v-if="kind === BACKEND_EMBEDDED">
          <label class="server-modal__label">{{ i18n.__('Status') }}</label>
          <div class="server-modal__embedded">
            <div class="server-modal__embedded-row">
              <span class="server-modal__dot" :class="embeddedDotClass"></span>
              <span class="server-modal__status" :class="embeddedStatusClass">
                {{ embeddedStatusText }}
              </span>
            </div>
            <p v-if="embeddedMissingText" class="server-modal__hint server-modal__hint--warn">
              {{ embeddedMissingText }}
            </p>
            <p v-else class="server-modal__hint">
              {{ i18n.__('Colorization runs on this computer. The app starts and stops the process for you.') }}
            </p>
          </div>
        </template>

        <template v-if="kind === BACKEND_HOSTED">
          <label class="server-modal__label" for="server-url-input">
            {{ i18n.__('Server URL') }}
          </label>
          <input
            id="server-url-input"
            ref="urlInput"
            v-model="url"
            class="server-modal__input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="http://localhost:8000"
            @keyup.enter="onEnter"
            @input="resetTest"
          />
          <p v-if="url && !isValid" class="server-modal__hint server-modal__hint--warn">
            {{ i18n.__('Enter a full URL starting with http:// or https://') }}
          </p>
          <p v-else class="server-modal__hint">
            {{ i18n.__('The app appends /colorize, /segment and /preprocess to this URL.') }}
          </p>
        </template>

        <div class="server-modal__test-row">
          <button
            class="server-modal__btn server-modal__btn--secondary"
            :disabled="!isValid || testing"
            @click="testConnection"
          >
            {{ testing ? i18n.__('Testing…') : i18n.__('Test connection') }}
          </button>
          <span
            class="server-modal__dot"
            :class="{
              'server-modal__dot--ok': testState === 'ok',
              'server-modal__dot--fail': testState === 'fail',
            }"
          ></span>
          <span
            v-if="testState"
            class="server-modal__status"
            :class="testState === 'ok' ? 'server-modal__status--ok' : 'server-modal__status--fail'"
          >
            {{ testMessage }}
          </span>
        </div>
      </div>

      <div class="server-modal__footer">
        <button
          class="server-modal__btn server-modal__btn--ghost"
          @click="close"
        >
          {{ firstRun ? i18n.__('Skip for now') : i18n.__('Cancel') }}
        </button>
        <button
          class="server-modal__btn server-modal__btn--primary"
          :disabled="!isValid"
          @click="save"
        >
          {{ i18n.__('Save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import axios from 'axios';
import { i18n } from '@/util/i18nVue';
import {
  normalizeServerUrl,
  coerceServerBackend,
  DEFAULT_SERVER_URL,
  SERVER_BACKEND_PREF_KEY,
  BACKEND_HOSTED,
  BACKEND_EMBEDDED,
} from '@/util/server-config';
import {
  setPref, ensureSidecar, getSidecarStatus, stopSidecar,
} from '@/platform';
import {
  updateSidecarStatus, getLastSidecarStatus, onSidecarStatus,
} from '@/util/sidecar-status';

export default {
  name: 'ServerSettingsModal',
  props: {
    isVisible: { type: Boolean, default: false },
    // Backend descriptor { kind, baseUrl } to seed the form with.
    initialBackend: { type: Object, default: null },
    firstRun: { type: Boolean, default: false },
  },
  data() {
    const backend = coerceServerBackend(this.initialBackend);
    return {
      i18n,
      BACKEND_HOSTED,
      BACKEND_EMBEDDED,
      kind: backend ? backend.kind : BACKEND_HOSTED,
      url: (backend && backend.baseUrl) || '',
      testing: false,
      testState: null, // null | 'ok' | 'fail'
      testMessage: '',
      // Live embedded-sidecar status pushed by the main-process supervisor.
      sidecarStatus: getLastSidecarStatus(),
    };
  },
  computed: {
    normalized() {
      return normalizeServerUrl(this.url);
    },
    isValid() {
      // The embedded backend needs no URL — its port exists only at runtime.
      if (this.kind === BACKEND_EMBEDDED) return true;
      return /^https?:\/\/.+/i.test(this.normalized);
    },
    embeddedDotClass() {
      const state = this.sidecarStatus && this.sidecarStatus.state;
      return {
        'server-modal__dot--ok': state === 'ready',
        'server-modal__dot--fail': state === 'failed',
        'server-modal__dot--busy': state === 'starting',
      };
    },
    embeddedStatusClass() {
      const state = this.sidecarStatus && this.sidecarStatus.state;
      return {
        'server-modal__status--ok': state === 'ready',
        'server-modal__status--fail': state === 'failed',
      };
    },
    embeddedStatusText() {
      const s = this.sidecarStatus;
      if (!s || s.state === 'stopped') {
        return i18n.__('Not running — starts when first needed.');
      }
      if (s.state === 'starting') return i18n.__('Starting…');
      if (s.state === 'ready') return i18n.__('Running on %s', `127.0.0.1:${s.port}`);
      if (s.state === 'failed') {
        return i18n.__('Failed: %s', s.lastError || i18n.__('unknown error'));
      }
      return '';
    },
    embeddedMissingText() {
      const s = this.sidecarStatus;
      if (!s || !s.missing || !s.missing.length) return '';
      const files = s.missing.map((m) => m.file).join(', ');
      return i18n.__('Missing: %s — place the files in %s', files, s.modelsDir);
    },
  },
  watch: {
    isVisible(visible) {
      if (visible) {
        // Re-seed from the latest known value each time the dialog opens.
        const backend = coerceServerBackend(this.initialBackend);
        this.kind = backend ? backend.kind : BACKEND_HOSTED;
        this.url = (backend && backend.baseUrl) || DEFAULT_SERVER_URL;
        this.resetTest();
        this.refreshSidecarStatus();
        this.$nextTick(() => {
          if (this.$refs.urlInput) this.$refs.urlInput.focus();
        });
      }
    },
    kind(value) {
      this.resetTest();
      // Show current (and missing-file) info as soon as embedded is picked.
      // A status snapshot never spawns the sidecar.
      if (value === BACKEND_EMBEDDED) this.refreshSidecarStatus();
    },
  },
  mounted() {
    // The modal stays mounted for the app's lifetime; keep its status live.
    this.unsubscribeSidecar = onSidecarStatus((status) => {
      this.sidecarStatus = status;
    });
  },
  beforeDestroy() {
    if (this.unsubscribeSidecar) this.unsubscribeSidecar();
  },
  methods: {
    resetTest() {
      this.testState = null;
      this.testMessage = '';
    },
    refreshSidecarStatus() {
      getSidecarStatus()
        .then((status) => updateSidecarStatus(status))
        .catch(() => {});
    },
    async testConnection() {
      if (!this.isValid || this.testing) return;
      this.testing = true;
      this.resetTest();
      try {
        let base = this.normalized;
        if (this.kind === BACKEND_EMBEDDED) {
          // Explicit user action: start (or retry) the sidecar, then health-
          // check it over HTTP exactly like a hosted backend.
          const status = await ensureSidecar({ retry: true });
          updateSidecarStatus(status);
          if (!status || status.state !== 'ready' || !status.baseUrl) {
            throw new Error((status && status.lastError) || 'sidecar not ready');
          }
          base = status.baseUrl;
        }
        const res = await axios.get(`${base}/health`, { timeout: 5000 });
        const gapCloser = res && res.data && res.data.gap_closer;
        this.testState = 'ok';
        this.testMessage = gapCloser
          ? i18n.__('Connected — server ready (gap closer enabled).')
          : i18n.__('Connected — server ready.');
      } catch (e) {
        this.testState = 'fail';
        this.testMessage = this.kind === BACKEND_EMBEDDED
          ? i18n.__('Embedded backend is not available — see the status above.')
          : i18n.__('Could not reach server. Check the URL and that the server is running.');
      } finally {
        this.testing = false;
      }
    },
    onEnter() {
      if (this.isValid) this.save();
    },
    save() {
      if (!this.isValid) return;
      // The embedded descriptor never carries a URL: the runtime port is
      // owned by the main process at spawn time and must not be persisted.
      const backend = this.kind === BACKEND_EMBEDDED
        ? { kind: BACKEND_EMBEDDED, baseUrl: '' }
        : { kind: this.kind, baseUrl: this.normalized };
      // Persist through the main process (single writer of user-preferences).
      setPref(SERVER_BACKEND_PREF_KEY, backend);
      if (this.kind === BACKEND_EMBEDDED) {
        // Choosing embedded is a first use — warm the sidecar up now so the
        // first colorize doesn't pay the spawn latency. Fire-and-forget;
        // progress arrives via the status pushes.
        ensureSidecar()
          .then((status) => updateSidecarStatus(status))
          .catch(() => {});
      } else {
        // Don't keep an app-managed sidecar running for a hosted backend.
        stopSidecar().catch(() => {});
      }
      this.$emit('save', backend);
      this.$emit('close');
    },
    onOverlayClick() {
      // Allow dismissing by clicking outside; on first run this behaves like Skip.
      this.close();
    },
    close() {
      this.$emit('close');
    },
  },
};
</script>

<style lang="scss" scoped>
.server-modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.server-modal {
  background-color: #353535;
  color: #c5c5c5;
  border-radius: 8px;
  padding: 1.5rem;
  width: 460px;
  max-width: calc(100vw - 2rem);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  margin: 1rem;
  border: 1px solid #4e4e4e;
}

.server-modal__header {
  margin-bottom: 1.25rem;

  h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1.4rem;
    font-weight: 600;
    color: #ffffff;
  }

  p {
    margin: 0;
    color: #898989;
    font-size: 0.9rem;
    line-height: 1.4;
  }
}

.server-modal__content {
  display: flex;
  flex-direction: column;
}

.server-modal__label {
  font-size: 0.8rem;
  color: #c5c5c5;
  margin-bottom: 0.4rem;
}

.server-modal__backends {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.server-modal__backend {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: #2d2d2d;
  border: 1px solid #4e4e4e;
  border-radius: 4px;
  padding: 0.55rem 0.75rem;
  font-size: 0.88rem;
  cursor: pointer;

  input {
    accent-color: #9834d3;
    margin: 0;
  }

  &--selected {
    border-color: #9834d3;
  }

  &--disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
}

.server-modal__backend-name {
  color: #ffffff;
}

.server-modal__backend-desc {
  color: #898989;
  font-size: 0.78rem;
  margin-left: auto;
}

.server-modal__input {
  background: #2d2d2d;
  border: 1px solid #4e4e4e;
  border-radius: 4px;
  color: #ffffff;
  padding: 0.6rem 0.75rem;
  font-size: 0.95rem;
  outline: none;

  &:focus {
    border-color: #9834d3;
  }
}

.server-modal__hint {
  margin: 0.5rem 0 0 0;
  font-size: 0.78rem;
  color: #898989;

  &--warn {
    color: #e0a640;
  }
}

.server-modal__test-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
}

.server-modal__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #898989;
  flex-shrink: 0;

  &--ok {
    background: #5cb85c;
  }

  &--fail {
    background: #d9534f;
  }

  &--busy {
    background: #e0a640;
  }
}

.server-modal__embedded {
  background: #2d2d2d;
  border: 1px solid #4e4e4e;
  border-radius: 4px;
  padding: 0.6rem 0.75rem;
  margin-bottom: 0.25rem;
}

.server-modal__embedded-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.server-modal__status {
  font-size: 0.82rem;

  &--ok {
    color: #5cb85c;
  }

  &--fail {
    color: #d9534f;
  }
}

.server-modal__footer {
  margin-top: 1.75rem;
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.server-modal__btn {
  padding: 0.55rem 1.1rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.88rem;
  border: 1px solid transparent;
  transition: all 0.2s ease;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.server-modal__btn--primary {
  background: #9834d3;
  color: #ffffff;

  &:hover:not(:disabled) {
    background: #8228bd;
  }
}

.server-modal__btn--secondary {
  background: #3a3a3a;
  border-color: #4e4e4e;
  color: #c5c5c5;

  &:hover:not(:disabled) {
    background: #2d2d2d;
    border-color: #898989;
  }
}

.server-modal__btn--ghost {
  background: transparent;
  border-color: #4e4e4e;
  color: #898989;

  &:hover:not(:disabled) {
    color: #ffffff;
    border-color: #898989;
  }
}
</style>
