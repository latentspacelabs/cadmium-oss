<template>
  <div
    v-if="summary.level !== 'hidden'"
    class="accel-chip"
    :class="`accel-chip--${summary.level}`"
    :title="detailText"
    @click="$emit('open')"
  >
    <span class="accel-chip__dot"></span>
    <span class="accel-chip__label">{{ labelText }}</span>
  </div>
</template>

<script>
// The main-window acceleration chip (docs/serving-setup-design.md, Phase 4):
// Full speed / Optimizing… / Reduced speed — visible without opening Server
// Settings, click opens it. Levels derived purely in util/accel-status.js
// from the pushed sidecar status (which carries the /health acceleration
// report) and model-download progress.
import { t } from '@/util/i18n';
import { mapGetters } from 'vuex';
import { SERVER_BACKEND } from '@/store/getter-types';
import { getSidecarStatus } from '@/platform';
import {
  updateSidecarStatus, getLastSidecarStatus, onSidecarStatus,
} from '@/util/sidecar-status';
import {
  getLastModelDownloadProgress, onModelDownloadProgress,
} from '@/util/model-download-status';
import { summarizeAcceleration } from '@/util/accel-status';

// A status poll doubles as a /health refresh (the main process re-polls the
// sidecar on every sidecar:status and pushes when the report changes), so
// the chip flips building → full without any user action.
const REFRESH_INTERVAL_MS = 20000;

export default {
  name: 'AccelChip',
  data() {
    return {
      sidecarStatus: getLastSidecarStatus(),
      downloadProgress: getLastModelDownloadProgress(),
    };
  },
  computed: {
    ...mapGetters({ serverBackend: SERVER_BACKEND }),
    summary() {
      return summarizeAcceleration({
        backendKind: this.serverBackend && this.serverBackend.kind,
        sidecarStatus: this.sidecarStatus,
        downloadProgress: this.downloadProgress,
      });
    },
    labelText() {
      const s = this.summary;
      if (s.level === 'downloading') return t('Downloading models… {{percent}}%', { percent: String(s.percent) });
      if (s.level === 'failed') return t('Backend failed');
      if (s.level === 'building') return t('Optimizing…');
      if (s.level === 'reduced') return t('Reduced speed');
      return t('Full speed');
    },
    detailText() {
      const s = this.summary;
      if (s.level === 'building') {
        return t('Preparing hardware acceleration for this computer — one-time, colorization works meanwhile.');
      }
      if (s.level === 'reduced') {
        const parts = [];
        if (s.reason) parts.push(s.reason);
        if (s.missingFiles && s.missingFiles.length) {
          parts.push(t('Missing: {{files}}', { files: s.missingFiles.join(', ') }));
        }
        parts.push(t('Click to open Server Settings.'));
        return parts.join(' · ');
      }
      if (s.level === 'failed') {
        return `${s.reason || t('Embedded backend failed')} · ${t('Click to open Server Settings.')}`;
      }
      return t('Colorization is hardware-accelerated.');
    },
  },
  mounted() {
    this.unsubStatus = onSidecarStatus((status) => { this.sidecarStatus = status; });
    this.unsubDownload = onModelDownloadProgress((p) => { this.downloadProgress = p; });
    const refresh = () => {
      getSidecarStatus()
        .then((status) => { if (status) updateSidecarStatus(status); })
        .catch(() => {});
    };
    refresh();
    this.refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  },
  beforeDestroy() {
    if (this.unsubStatus) this.unsubStatus();
    if (this.unsubDownload) this.unsubDownload();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  },
};
</script>

<style lang="scss" scoped>
.accel-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid #4e4e4e;
  background: #2d2d2d;
  font-size: 0.72rem;
  color: #c5c5c5;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;

  &__dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #898989;
    flex-shrink: 0;
  }

  &--full &__dot { background: #5cb85c; }
  &--building &__dot,
  &--downloading &__dot {
    background: #4a90d9;
    animation: accel-chip-pulse 1.2s ease-in-out infinite;
  }
  &--reduced &__dot { background: #e0a640; }
  &--failed &__dot { background: #d9534f; }
}

@keyframes accel-chip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
