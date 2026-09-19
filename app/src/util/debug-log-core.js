/* eslint-disable */
/**
 * Pure logic for the in-app debug log (the Debug Log panel): a bounded ring
 * of log lines from the sidecar child process and the app-side supervisor.
 * No Electron, no fs, no timers — the effectful wiring (taps, IPC batching)
 * lives in background.js.
 *
 * Entry shape: { seq, ts, source, line }
 *  - seq: monotonically increasing for the app session (survives sidecar
 *    restarts) — the renderer's dedup key for the history-vs-live-push race.
 *  - source: 'app' (supervisor lines + synthesized acceleration transitions),
 *    'sidecar' (child stdout), 'sidecar-err' (child stderr).
 */

export const DEBUG_LOG_MAX_ENTRIES = 2000;
export const DEBUG_LOG_MAX_LINE_CHARS = 500;

// ANSI escapes: CSI (ESC [ ... final byte), OSC (ESC ] ... BEL/ST), then any
// other lone ESC-prefixed byte. The sidecar's tracing-subscriber fmt layer
// colors its output even into a pipe (the `ansi` feature does not TTY-detect),
// so child stdout arrives with color codes that must not reach the panel.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/**
 * The ring buffer. All methods are synchronous and never throw; listener
 * errors are swallowed (a broken subscriber must not break logging).
 */
export function createDebugLog({
  maxEntries = DEBUG_LOG_MAX_ENTRIES,
  maxLineChars = DEBUG_LOG_MAX_LINE_CHARS,
  nowFn = Date.now,
} = {}) {
  const ring = [];
  const carries = Object.create(null); // source -> trailing unterminated fragment
  const listeners = new Set();
  let seq = 0;

  function push(source, rawLine) {
    let line = stripAnsi(rawLine).replace(/\s+$/, '');
    if (line.length > maxLineChars) line = `${line.slice(0, maxLineChars)}…`;
    const entry = { seq: seq++, ts: nowFn(), source, line };
    ring.push(entry);
    if (ring.length > maxEntries) ring.splice(0, ring.length - maxEntries);
    listeners.forEach((fn) => {
      try {
        fn(entry);
      } catch (e) {
        // One bad listener must not starve the rest.
      }
    });
    return entry;
  }

  return {
    /** One complete line (already newline-free). */
    append(source, line) {
      return push(source, String(line));
    },

    /**
     * A raw child-output chunk (Buffer or string). Splits on \r\n, \n, and
     * lone \r (CoreML/ORT progress rewrites); the trailing unterminated
     * fragment is carried per source until the next chunk completes it. A
     * carry past maxLineChars can only grow (progress spew with no newline),
     * so it is force-flushed truncated instead of held unboundedly.
     */
    appendChunk(source, chunk) {
      const text = (carries[source] || '') + String(chunk);
      const parts = text.split(/\r\n|\n|\r/);
      let carry = parts.pop();
      const out = [];
      parts.forEach((part) => {
        if (part.trim().length) out.push(push(source, part));
      });
      if (carry.length > maxLineChars) {
        out.push(push(source, carry));
        carry = '';
      }
      carries[source] = carry;
      return out;
    },

    /** Emit trailing partial lines (child gone; nothing will complete them). */
    flushCarry(source) {
      const sources = source ? [source] : Object.keys(carries);
      const out = [];
      sources.forEach((s) => {
        const carry = carries[s];
        carries[s] = '';
        if (carry && carry.trim().length) out.push(push(s, carry));
      });
      return out;
    },

    /** Snapshot copy of the ring, oldest first. */
    entries() {
      return ring.slice();
    },

    /** Per-entry listener; returns an unsubscribe function. */
    onAppend(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Acceleration transitions worth a log line, from two consecutive status
 * snapshots (sidecar-manager getStatus shape). ONLY acceleration — state
 * transitions already reach the debug log through the supervisor's logFn
 * (`state -> ready`, spawn/crash/restart lines), while /health-driven
 * acceleration changes bypass logFn entirely (refreshHealth pushes onStatus
 * without logging). Pure and stateless: identical consecutive snapshots
 * (the 5s building re-poll) produce [].
 */
export function accelerationTransitionLines(prevStatus, nextStatus) {
  const lines = [];
  const prevAccel = (prevStatus && prevStatus.health && prevStatus.health.acceleration) || {};
  const nextAccel = (nextStatus && nextStatus.health && nextStatus.health.acceleration) || {};
  Object.keys(nextAccel).forEach((capName) => {
    const cap = nextAccel[capName];
    if (!cap) return;
    const prev = prevAccel[capName] || {};
    if (prev.active === cap.active && (prev.reason || null) === (cap.reason || null)) return;
    let line = `acceleration ${capName}: ${cap.active}`;
    if (cap.planned && cap.planned !== cap.active && cap.active !== 'building') {
      line += ` (planned ${cap.planned})`;
    }
    if (cap.reason) line += ` — reason: ${cap.reason}`;
    lines.push(line);
  });
  return lines;
}
