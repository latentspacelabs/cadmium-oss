<template>
  <div class="server-modal-overlay" v-if="isVisible" @click="onOverlayClick">
    <div class="server-modal" @click.stop>
      <div class="server-modal__header">
        <h2>{{ firstRun ? t('Choose how Cadmium runs') : t('Server Settings') }}</h2>
        <!-- eslint-disable max-len — the natural-sentence i18n keys cannot be wrapped -->
        <p>{{
          firstRun
            ? t('Cadmium colorizes your art with an AI model. Run it on this computer, or connect to a server you host. You can change this anytime in Settings.')
            : t('Colorize, analyze, and preprocess requests are sent to this backend.')
        }}</p>
        <!-- eslint-enable max-len -->
      </div>

      <div class="server-modal__content">
        <label class="server-modal__label">{{ t('Backend') }}</label>
        <div class="server-modal__backends">
          <label
            class="server-modal__backend"
            :class="{
              'server-modal__backend--selected': kind === BACKEND_EMBEDDED,
              'server-modal__backend--disabled': embeddedBlocked,
            }"
          >
            <input
              type="radio"
              :value="BACKEND_EMBEDDED"
              v-model="kind"
              :disabled="embeddedBlocked"
            />
            <span class="server-modal__backend-body">
              <span class="server-modal__backend-name">
                {{ t('Embedded (this computer)') }}
                <span v-if="firstRun && !embeddedBlocked" class="server-modal__badge">
                  {{ t('Recommended') }}
                </span>
              </span>
              <!-- eslint-disable-next-line max-len -->
              <span class="server-modal__backend-desc">{{ t('Runs colorization entirely on this computer. No account or internet needed after a one-time model download.') }}</span>
              <span class="server-modal__backend-meta">{{ embeddedRequirementsText }}</span>
            </span>
          </label>
          <label
            class="server-modal__backend"
            :class="{ 'server-modal__backend--selected': kind === BACKEND_HOSTED }"
          >
            <input type="radio" :value="BACKEND_HOSTED" v-model="kind" />
            <span class="server-modal__backend-body">
              <span class="server-modal__backend-name">{{ t('Hosted server') }}</span>
              <!-- eslint-disable-next-line max-len -->
              <span class="server-modal__backend-desc">{{ t('Send work to a Cadmium server you run or can reach by URL — for example a GPU box on your network.') }}</span>
              <span class="server-modal__backend-meta">
                {{ t('Needs a running server and network access.') }}
              </span>
            </span>
          </label>
        </div>

        <template v-if="kind === BACKEND_EMBEDDED">
          <label class="server-modal__label">{{ t('This computer') }}</label>
          <div class="server-modal__caps">
            <div
              v-for="row in capabilityRows"
              :key="row.key"
              class="server-modal__caps-row"
            >
              <span
                class="server-modal__caps-icon"
                :class="`server-modal__caps-icon--${row.status}`"
              >{{ capIconSymbol(row.status) }}</span>
              <span class="server-modal__caps-name">{{ row.label }}</span>
              <span class="server-modal__caps-detail">{{ row.detail }}</span>
            </div>
            <p v-if="!capabilities" class="server-modal__hint">
              {{ t('Checking this computer…') }}
            </p>
            <p v-if="embeddedBlocked" class="server-modal__hint server-modal__hint--warn">
              {{ embeddedBlockedText }}
            </p>
          </div>

          <label class="server-modal__label">{{ t('Status') }}</label>
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
              <!-- eslint-disable-next-line max-len -->
              {{ t('Colorization runs on this computer. The app starts and stops the process for you.') }}
            </p>

            <div v-if="accelRows.length" class="server-modal__accel">
              <div
                v-for="row in accelRows"
                :key="row.key"
                class="server-modal__caps-row"
              >
                <span
                  class="server-modal__caps-icon"
                  :class="`server-modal__caps-icon--${row.status}`"
                >{{ capIconSymbol(row.status) }}</span>
                <span class="server-modal__caps-name server-modal__caps-name--accel">
                  {{ row.label }}
                </span>
                <span class="server-modal__caps-detail">{{ row.detail }}</span>
              </div>
            </div>

            <template v-if="downloadActive">
              <div class="server-modal__progress">
                <div
                  class="server-modal__progress-fill"
                  :style="{ width: `${downloadPercent}%` }"
                ></div>
              </div>
              <div class="server-modal__embedded-row">
                <span class="server-modal__hint">{{ downloadProgressText }}</span>
                <button
                  class="server-modal__btn server-modal__btn--secondary"
                  @click="cancelDownload"
                >
                  {{ t('Cancel download') }}
                </button>
              </div>
            </template>
            <template v-else-if="missingModels.length">
              <p v-if="downloadError" class="server-modal__hint server-modal__hint--warn">
                {{ downloadErrorText }}
              </p>
              <button
                class="server-modal__btn server-modal__btn--secondary"
                @click="startDownload"
              >
                {{ downloadButtonLabel }}
              </button>
            </template>
          </div>
        </template>

        <template v-if="kind === BACKEND_HOSTED">
          <label class="server-modal__label" for="server-url-input">
            {{ t('Server URL') }}
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
            {{ t('Enter a full URL starting with http:// or https://') }}
          </p>
          <p v-else class="server-modal__hint">
            {{ t('The app appends /colorize, /segment and /preprocess to this URL.') }}
          </p>
        </template>

        <div class="server-modal__test-row">
          <button
            class="server-modal__btn server-modal__btn--secondary"
            :disabled="!isValid || testing"
            @click="testConnection"
          >
            {{ testing ? t('Testing…') : t('Test connection') }}
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
          v-if="!firstRun"
          class="server-modal__btn server-modal__btn--ghost"
          @click="close"
        >
          {{ t('Cancel') }}
        </button>
        <button
          class="server-modal__btn server-modal__btn--primary"
          :disabled="!isValid"
          @click="save"
        >
          {{ firstRun ? t('Get started') : t('Save') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import axios from 'axios';
import { t } from '@/util/i18n';
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
  getModelDownloadPlan, downloadModels, cancelModelDownload, getModelDownloadProgress,
  getSystemCapabilities,
} from '@/platform';
import {
  updateSidecarStatus, getLastSidecarStatus, onSidecarStatus,
} from '@/util/sidecar-status';
import {
  getLastModelDownloadProgress, onModelDownloadProgress,
} from '@/util/model-download-status';
import { formatGB } from '@/util/model-download-core';
import { evaluateEmbeddedCapability } from '@/util/embedded-capability';

// RAM the way people quote it (binary GiB), so a "16 GB" machine reads "16 GB"
// rather than the 17.2 GB a decimal formatGB would print for os.totalmem().
function formatMemGiB(bytes) {
  if (!bytes) return '0 GB';
  return `${Math.round(bytes / (1024 ** 3))} GB`;
}

// The radio to preselect: a saved backend's kind; otherwise embedded on first
// run (the recommended no-setup path), hosted in the settings dialog.
function defaultBackendKind(backend, firstRun) {
  if (backend) return backend.kind;
  return firstRun ? BACKEND_EMBEDDED : BACKEND_HOSTED;
}

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
      t,
      BACKEND_HOSTED,
      BACKEND_EMBEDDED,
      // First run defaults to embedded (the no-setup, recommended path); if the
      // hardware check comes back "unsupported" we fall it back to hosted.
      kind: defaultBackendKind(backend, this.firstRun),
      url: (backend && backend.baseUrl) || '',
      testing: false,
      testState: null, // null | 'ok' | 'fail'
      testMessage: '',
      // Live embedded-sidecar status pushed by the main-process supervisor.
      sidecarStatus: getLastSidecarStatus(),
      // Live model-download progress (same push pattern).
      downloadProgress: getLastModelDownloadProgress(),
      // Bytes a download would fetch right now (null until probed).
      downloadPlanBytes: null,
      // Machine capabilities for the embedded hardware check (null until probed).
      capabilities: null,
    };
  },
  computed: {
    normalized() {
      return normalizeServerUrl(this.url);
    },
    isValid() {
      // The embedded backend needs no URL — its port exists only at runtime —
      // but can't be saved on a machine that fails the hardware check.
      if (this.kind === BACKEND_EMBEDDED) return !this.embeddedBlocked;
      return /^https?:\/\/.+/i.test(this.normalized);
    },
    // The hardware verdict for the embedded backend (pure; re-derived from the
    // probed capabilities + what a model download would still fetch).
    embeddedCapability() {
      return evaluateEmbeddedCapability(this.capabilities, {
        neededBytes: this.downloadPlanBytes || 0,
      });
    },
    // "Blocked" only once we've actually probed — never disable optimistically.
    embeddedBlocked() {
      return !!this.capabilities && !this.embeddedCapability.supported;
    },
    embeddedRequirementsText() {
      const parts = [];
      if (this.downloadPlanBytes) {
        parts.push(t('~{{size}} download', { size: formatGB(this.downloadPlanBytes) }));
      }
      parts.push(t('Apple Silicon Mac or 64-bit Windows'));
      parts.push(t('8 GB RAM recommended'));
      return parts.join(' · ');
    },
    capabilityRows() {
      if (!this.capabilities) return [];
      const { checks } = this.embeddedCapability;
      return [
        {
          key: 'system', status: checks.system.status, label: t('System'), detail: this.systemDetail(checks.system),
        },
        {
          key: 'disk', status: checks.disk.status, label: t('Storage'), detail: this.diskDetail(checks.disk),
        },
        {
          key: 'ram', status: checks.ram.status, label: t('Memory'), detail: this.ramDetail(checks.ram),
        },
        {
          key: 'gpu', status: checks.gpu.status, label: t('Graphics'), detail: this.gpuDetail(checks.gpu),
        },
      ];
    },
    embeddedBlockedText() {
      const { checks } = this.embeddedCapability;
      if (checks.system && checks.system.status === 'blocked') {
        // eslint-disable-next-line max-len
        return t('This computer can’t run the embedded backend — it needs an Apple Silicon Mac or a 64-bit Windows PC. Choose a hosted server instead.');
      }
      if (checks.disk && checks.disk.status === 'blocked') {
        // eslint-disable-next-line max-len
        return t('Not enough free disk space for the model download. Free up space, or choose a hosted server.');
      }
      return '';
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
        return t('Not running — starts when first needed.');
      }
      if (s.state === 'starting') return t('Starting…');
      if (s.state === 'ready') return t('Running on {{address}}', { address: `127.0.0.1:${s.port}` });
      if (s.state === 'failed') {
        // Hoisted out of the t() options: i18next-parser doesn't descend
        // into a matched call's arguments, so a nested t('unknown error')
        // would never reach the catalogs.
        const reason = s.lastError || t('unknown error');
        return t('Failed: {{error}}', { error: reason });
      }
      return '';
    },
    embeddedMissingText() {
      const s = this.sidecarStatus;
      if (!s || !s.missing || !s.missing.length) return '';
      const files = s.missing.map((m) => m.file).join(', ');
      return t('Missing: {{files}} — place the files in {{dir}}', { files, dir: s.modelsDir });
    },
    missingModels() {
      const s = this.sidecarStatus;
      return ((s && s.missing) || []).filter((m) => m.kind === 'model');
    },
    downloadActive() {
      const state = this.downloadProgress && this.downloadProgress.state;
      return state === 'downloading' || state === 'verifying';
    },
    downloadError() {
      const p = this.downloadProgress;
      return p && p.state === 'failed' ? p.error : '';
    },
    downloadErrorText() {
      // Kept out of the template: a literal {{error}} inside a mustache
      // would end Vue's text interpolation early.
      return this.downloadError
        ? t('Download failed: {{error}}', { error: this.downloadError })
        : '';
    },
    downloadPercent() {
      const p = this.downloadProgress;
      if (!p || !p.totalBytes) return 0;
      return Math.min(100, Math.floor((p.receivedBytes / p.totalBytes) * 100));
    },
    downloadButtonLabel() {
      return this.downloadPlanBytes
        ? t('Download models ({{size}})', { size: formatGB(this.downloadPlanBytes) })
        : t('Download models');
    },
    downloadProgressText() {
      const p = this.downloadProgress;
      if (!p) return '';
      if (p.state === 'verifying') return t('Verifying {{file}}…', { file: p.file });
      return t(
        '{{file}} ({{index}} of {{count}}) — {{received}} of {{total}}',
        {
          file: p.file,
          index: String(p.fileIndex + 1),
          count: String(p.fileCount),
          received: formatGB(p.receivedBytes),
          total: formatGB(p.totalBytes),
        },
      );
    },
    // Per-capability hardware-acceleration rows from the sidecar's /health
    // report (expected vs actual — see docs/serving-setup-design.md). Empty
    // until the sidecar is ready and reporting.
    accelRows() {
      const s = this.sidecarStatus;
      const accel = s && s.health && s.health.acceleration;
      if (!accel) return [];
      return [
        { key: 'colorize', label: t('Colorize'), ...this.accelPresentation(accel.colorize) },
        { key: 'segment', label: t('Gap closing'), ...this.accelPresentation(accel.segment) },
      ];
    },
  },
  watch: {
    isVisible(visible) {
      if (visible) {
        // Re-seed from the latest known value each time the dialog opens.
        const backend = coerceServerBackend(this.initialBackend);
        this.kind = defaultBackendKind(backend, this.firstRun);
        this.url = (backend && backend.baseUrl) || DEFAULT_SERVER_URL;
        this.resetTest();
        this.refreshSidecarStatus();
        this.refreshDownloadPlan();
        this.loadCapabilities();
        this.$nextTick(() => {
          if (this.$refs.urlInput) this.$refs.urlInput.focus();
        });
      }
    },
    kind(value) {
      this.resetTest();
      // Show current (and missing-file) info as soon as embedded is picked.
      // A status snapshot never spawns the sidecar.
      if (value === BACKEND_EMBEDDED) {
        this.refreshSidecarStatus();
        this.refreshDownloadPlan();
        this.loadCapabilities();
      }
    },
  },
  mounted() {
    // Probe the machine once up front so the hardware verdict is ready the
    // instant embedded is shown (specs don't change within a session).
    this.loadCapabilities();
    // The modal stays mounted for the app's lifetime; keep its status live.
    this.unsubscribeSidecar = onSidecarStatus((status) => {
      this.sidecarStatus = status;
    });
    this.unsubscribeDownload = onModelDownloadProgress((progress) => {
      this.downloadProgress = progress;
      // A finished run changes what's missing and what a retry would fetch.
      if (progress.state === 'done' || progress.state === 'failed' || progress.state === 'cancelled') {
        this.refreshSidecarStatus();
        this.refreshDownloadPlan();
      }
    });
  },
  beforeDestroy() {
    if (this.unsubscribeSidecar) this.unsubscribeSidecar();
    if (this.unsubscribeDownload) this.unsubscribeDownload();
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
    loadCapabilities() {
      // Machine specs are fixed for the session — probe once and cache.
      if (this.capabilities) return;
      getSystemCapabilities()
        .then((caps) => {
          this.capabilities = caps || null;
          // If we optimistically defaulted to embedded but this machine can't
          // run it, fall back to hosted so the user isn't stuck on a disabled
          // option with a disabled Save button.
          if (this.kind === BACKEND_EMBEDDED && this.embeddedBlocked) {
            this.kind = BACKEND_HOSTED;
          }
        })
        .catch(() => { this.capabilities = null; });
    },
    capIconSymbol(status) {
      return {
        ok: '✓', warn: '!', blocked: '✕', info: 'ℹ', unknown: '–',
      }[status] || '–';
    },
    humanPlatform(platform) {
      if (platform === 'darwin') return t('macOS');
      if (platform === 'win32') return t('Windows');
      if (platform === 'linux') return t('Linux');
      return platform || t('Unknown');
    },
    systemDetail(check) {
      if (check.status === 'ok') {
        return t('{{os}} · supported', { os: this.humanPlatform(check.platform) });
      }
      return t('{{os}} ({{arch}}) · not supported', {
        os: this.humanPlatform(check.platform),
        arch: check.arch || '?',
      });
    },
    diskDetail(check) {
      if (check.status === 'unknown') return t('Could not check free space');
      const free = formatGB(check.freeBytes);
      if (check.status === 'ok') return t('{{free}} free', { free });
      const needed = formatGB(check.neededBytes);
      if (check.status === 'warn') return t('{{free}} free · {{needed}} needed', { free, needed });
      return t('Only {{free}} free · {{needed}} needed', { free, needed });
    },
    ramDetail(check) {
      if (check.status === 'unknown') return t('Could not read memory');
      const total = formatMemGiB(check.totalBytes);
      if (check.status === 'ok') return t('{{total}} RAM', { total });
      return t('{{total}} RAM · 8 GB recommended', { total });
    },
    gpuDetail(check) {
      if (check.accelerated === true) return t('Hardware acceleration available');
      if (check.accelerated === false) return t('No GPU detected · will use the CPU (slower)');
      return t('Graphics acceleration status unknown');
    },
    // { planned, active, reason } from the sidecar → an icon status + text.
    // CPU with a reason is a degradation (warn + why); CPU without one is
    // by-design (info). `building` is the one-time CoreML compile window.
    accelPresentation(cap) {
      if (!cap) return { status: 'unknown', detail: t('Unknown') };
      if (cap.active === 'building') {
        return { status: 'info', detail: t('Optimizing for this computer — one-time, a few minutes') };
      }
      if (cap.active === 'coreml') {
        return { status: 'ok', detail: t('Hardware accelerated (Apple GPU / Neural Engine)') };
      }
      if (cap.active === 'dml') {
        return { status: 'ok', detail: t('Hardware accelerated (DirectML GPU)') };
      }
      if (cap.reason) {
        return { status: 'warn', detail: t('CPU (slower) — {{reason}}', { reason: cap.reason }) };
      }
      return { status: 'info', detail: t('CPU') };
    },
    refreshDownloadPlan() {
      getModelDownloadPlan()
        .then((plan) => { this.downloadPlanBytes = plan ? plan.totalBytes : null; })
        .catch(() => { this.downloadPlanBytes = null; });
      // Re-seed live progress too: after a renderer reload the push cache
      // starts idle even if the main process is mid-download.
      getModelDownloadProgress()
        .then((progress) => { if (progress) this.downloadProgress = progress; })
        .catch(() => {});
    },
    startDownload() {
      // Fire-and-forget: progress and the terminal state arrive as pushes;
      // the main process re-ensures the sidecar itself after a success.
      downloadModels().catch(() => {});
    },
    cancelDownload() {
      cancelModelDownload().catch(() => {});
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
          ? t('Connected — server ready (gap closer enabled).')
          : t('Connected — server ready.');
      } catch (e) {
        this.testState = 'fail';
        this.testMessage = this.kind === BACKEND_EMBEDDED
          ? t('Embedded backend is not available — see the status above.')
          : t('Could not reach server. Check the URL and that the server is running.');
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
        const needsDownload = this.missingModels.length > 0
          || (typeof this.downloadPlanBytes === 'number' && this.downloadPlanBytes > 0);
        if (needsDownload) {
          // Choosing embedded is the moment to fetch the one-time model
          // download this dialog advertised — without it the sidecar has no
          // models to serve. Don't ensureSidecar() here (it would only flap to
          // "failed: missing"); the main process re-ensures the sidecar once
          // the download completes. Progress arrives via the status pushes and
          // is visible on reopening Server Settings.
          this.startDownload();
        } else {
          // Models already present — warm the sidecar now so the first
          // colorize doesn't pay the spawn latency. Fire-and-forget.
          ensureSidecar()
            .then((status) => updateSidecarStatus(status))
            .catch(() => {});
        }
      } else {
        // Don't keep an app-managed sidecar running for a hosted backend.
        stopSidecar().catch(() => {});
      }
      this.$emit('save', backend);
      this.$emit('close');
    },
    onOverlayClick() {
      // On first run the backend choice is required — clicking the backdrop
      // must not dismiss it. Afterwards, allow closing.
      if (this.firstRun) return;
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
  align-items: flex-start;
  gap: 0.6rem;
  background: #2d2d2d;
  border: 1px solid #4e4e4e;
  border-radius: 4px;
  padding: 0.6rem 0.75rem;
  font-size: 0.88rem;
  cursor: pointer;

  input {
    accent-color: #9834d3;
    margin: 0.2rem 0 0 0;
    flex-shrink: 0;
  }

  &--selected {
    border-color: #9834d3;
  }

  &--disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
}

.server-modal__backend-body {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.server-modal__backend-name {
  color: #ffffff;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.server-modal__badge {
  font-size: 0.64rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #ffffff;
  background: #9834d3;
  border-radius: 3px;
  padding: 0.1rem 0.35rem;
}

.server-modal__backend-desc {
  color: #a9a9a9;
  font-size: 0.78rem;
  line-height: 1.35;
}

.server-modal__backend-meta {
  color: #7c7c7c;
  font-size: 0.72rem;
}

.server-modal__caps {
  background: #2d2d2d;
  border: 1px solid #4e4e4e;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
}

.server-modal__caps-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.18rem 0;
  font-size: 0.8rem;
}

.server-modal__caps-icon {
  width: 1rem;
  text-align: center;
  font-size: 0.78rem;
  flex-shrink: 0;
  color: #898989;

  &--ok { color: #5cb85c; }
  &--warn { color: #e0a640; }
  &--blocked { color: #d9534f; }
  &--info { color: #4a90d9; }
}

.server-modal__caps-name {
  color: #c5c5c5;
  width: 68px;
  flex-shrink: 0;

  // "Gap closing" needs a little more room than the capability names.
  &--accel { width: 84px; }
}

// Acceleration rows inside the embedded Status box, set off from the hints.
.server-modal__accel {
  border-top: 1px solid #4e4e4e;
  margin-top: 0.5rem;
  padding-top: 0.35rem;
}

.server-modal__caps-detail {
  color: #898989;
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

.server-modal__progress {
  margin-top: 0.6rem;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.server-modal__progress-fill {
  height: 100%;
  border-radius: 3px;
  background: #4a90d9;
  transition: width 0.2s ease;
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
