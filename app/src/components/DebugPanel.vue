<template>
  <div v-if="isVisible" class="debug-panel">
    <div class="debug-panel__header">
      <span class="debug-panel__dot" :class="dotClass"></span>
      <span class="debug-panel__title">{{ t('Debug Log') }}</span>
      <span class="debug-panel__accel">{{ accelSummary }}</span>
      <span class="debug-panel__spacer"></span>
      <button class="debug-panel__btn" @click="copyAll">{{ t('Copy') }}</button>
      <button class="debug-panel__btn" @click="clearView">{{ t('Clear') }}</button>
      <button class="debug-panel__btn" @click="revealLog">{{ t('Log File') }}</button>
      <button class="debug-panel__btn" @click="$emit('close')">{{ t('Close') }}</button>
    </div>
    <div ref="stream" class="debug-panel__stream" @scroll="onScroll">
      <div
        v-for="entry in visibleEntries"
        :key="entry.seq"
        class="debug-panel__line"
        :class="`debug-panel__line--${entry.source}`"
      >
        <span class="debug-panel__ts">{{ formatTs(entry.ts) }} </span>{{ entry.line }}
      </div>
      <div v-if="!visibleEntries.length" class="debug-panel__empty">
        {{ t('No log output yet. Run a colorization to start the local server.') }}
      </div>
    </div>
  </div>
</template>

<script>
// Live text stream of the embedded backend's activity: supervisor lines
// (state transitions, spawns, crashes, restarts), sidecar stdout/stderr, and
// acceleration transitions — the client-side diagnosis surface for "the
// server crashed" and "it's on CPU instead of GPU". Data flows main process
// ring -> 'sidecar:log' batches -> util/sidecar-log.js cache -> here; this
// component subscribes to the cache only, never to IPC directly (the
// ipc-renderer-handlers.js rule).
import { t } from '@/util/i18n';
import {
  getSidecarLogEntries,
  onSidecarLog,
  ensureSidecarLogHistory,
} from '@/util/sidecar-log';
import { getLastSidecarStatus, onSidecarStatus } from '@/util/sidecar-status';
import { writeClipboardText, revealSidecarLogFile } from '@/platform';

// Rendered-line cap: the cache holds 2000 entries, the DOM shows the tail.
const VISIBLE_LINES = 500;

export default {
  name: 'DebugPanel',
  props: {
    isVisible: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      t,
      entries: getSidecarLogEntries(),
      sidecarStatus: getLastSidecarStatus(),
      // View-only clear: hide everything at or below this seq.
      clearedBeforeSeq: -1,
      // Follow-tail: stick to the bottom until the user scrolls up.
      follow: true,
    };
  },
  computed: {
    visibleEntries() {
      return this.entries
        .filter((e) => e.seq > this.clearedBeforeSeq)
        .slice(-VISIBLE_LINES);
    },
    dotClass() {
      const state = this.sidecarStatus && this.sidecarStatus.state;
      return {
        'debug-panel__dot--ok': state === 'ready',
        'debug-panel__dot--busy': state === 'starting',
        'debug-panel__dot--fail': state === 'failed',
      };
    },
    // Compact per-capability summary, e.g. "colorize: coreml · segment: cpu
    // (no bucket model)". Raw report values on purpose — this is a debug
    // surface, not user-facing prose.
    accelSummary() {
      const status = this.sidecarStatus;
      if (!status) return '';
      const accel = status.health && status.health.acceleration;
      if (!accel) return status.state || '';
      const parts = Object.keys(accel).map((name) => {
        const cap = accel[name];
        if (!cap || !cap.active) return `${name}: —`;
        return `${name}: ${cap.active}${cap.reason ? ` (${cap.reason})` : ''}`;
      });
      const o = status.optimizing;
      if (o) parts.push(`optimizing ${o.phase} ${o.done}/${o.total}`);
      return parts.join(' · ');
    },
  },
  watch: {
    isVisible(visible) {
      if (visible) {
        ensureSidecarLogHistory();
        this.follow = true;
        this.stickToBottom();
      }
    },
  },
  mounted() {
    this.unsubscribeLog = onSidecarLog(() => {
      this.entries = getSidecarLogEntries();
      this.stickToBottom();
    });
    this.unsubscribeStatus = onSidecarStatus((status) => {
      this.sidecarStatus = status;
    });
    if (this.isVisible) ensureSidecarLogHistory();
  },
  beforeDestroy() {
    if (this.unsubscribeLog) this.unsubscribeLog();
    if (this.unsubscribeStatus) this.unsubscribeStatus();
  },
  methods: {
    onScroll() {
      const el = this.$refs.stream;
      if (!el) return;
      this.follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    },
    stickToBottom() {
      if (!this.follow) return;
      this.$nextTick(() => {
        const el = this.$refs.stream;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
    formatTs(ts) {
      const d = new Date(ts);
      const pad = (n, w = 2) => String(n).padStart(w, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    },
    copyAll() {
      const text = this.visibleEntries
        .map((e) => `${new Date(e.ts).toISOString()} [${e.source}] ${e.line}`)
        .join('\n');
      writeClipboardText(text);
    },
    clearView() {
      if (this.entries.length) {
        this.clearedBeforeSeq = this.entries[this.entries.length - 1].seq;
      }
    },
    revealLog() {
      revealSidecarLogFile().catch(() => {});
    },
  },
};
</script>

<style lang="scss" scoped>
// Docked bottom strip: a flow child of the Home column — the main pane
// shrinks to make room (see Home.vue), so nothing is covered. The modals
// are fixed overlays and still render above it. Height must stay in sync
// with --debug-panel-height in Home.vue.
.debug-panel {
  flex-shrink: 0;
  height: var(--debug-panel-height, 30vh);
  display: flex;
  flex-direction: column;
  background: #2d2d2d;
  border-top: 1px solid #4e4e4e;
  overflow: hidden;
  // Above the colorize/analyze overlay (fixed, z-index 100 — see
  // ImageImportWaitingScreen.vue) so the stream stays visible and usable
  // during runs; its centered spinner/Stop button are unaffected.
  position: relative;
  z-index: 101;
}

.debug-panel__header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.3rem 0.7rem;
  background: #353535;
  border-bottom: 1px solid #4e4e4e;
  flex-shrink: 0;
}

.debug-panel__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #898989;
  flex-shrink: 0;

  &--ok {
    background: #5cb85c;
  }

  &--busy {
    background: #e0a640;
  }

  &--fail {
    background: #d9534f;
  }
}

.debug-panel__title {
  color: #ffffff;
  font-size: 0.82rem;
  font-weight: 600;
  white-space: nowrap;
}

.debug-panel__accel {
  color: #898989;
  font-size: 0.78rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.debug-panel__spacer {
  flex-grow: 1;
}

.debug-panel__btn {
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.76rem;
  background: transparent;
  border: 1px solid #4e4e4e;
  color: #c5c5c5;
  transition: all 0.2s ease;
  white-space: nowrap;

  &:hover {
    border-color: #9834d3;
    color: #ffffff;
  }
}

.debug-panel__stream {
  flex: 1;
  overflow-y: auto;
  padding: 0.4rem 0.7rem;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: #c5c5c5;
  user-select: text;
  cursor: text;

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-thumb {
    background: #4e4e4e;
    border-radius: 4px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }
}

.debug-panel__line {
  white-space: pre-wrap;
  word-break: break-all;

  // Supervisor + synthesized transition lines.
  &--app {
    color: #9a9a9a;
  }

  // Child stderr (crash output, panics).
  &--sidecar-err {
    color: #e0a640;
  }
}

.debug-panel__ts {
  color: #6d6d6d;
  margin-right: 0.6em;
}

.debug-panel__empty {
  color: #898989;
  font-family: 'Inter', sans-serif;
  font-size: 0.82rem;
  padding: 0.5rem 0;
}
</style>
