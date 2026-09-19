/* eslint-disable */
/**
 * Renderer-side cache of the main process's debug log — the supervisor +
 * sidecar output lines shown in the Debug Log panel.
 *
 * Live batches arrive on the 'sidecar:log' IPC channel, funneled here by
 * ipc-renderer-handlers.js (which subscribes once at boot, so the cache
 * accumulates even while the panel is closed — same rule as
 * util/sidecar-status.js: UI subscribes to this module, never to IPC). The
 * panel additionally fetches the main process's full ring once
 * (ensureSidecarLogHistory) to cover lines from before the renderer existed;
 * entries carry a monotonic `seq`, so merging history with concurrently
 * arriving live batches is a dedup-by-seq union.
 *
 * Entry shape (util/debug-log-core.js): { seq, ts, source, line }.
 */

import { getSidecarLogHistory } from '../platform';

const MAX_ENTRIES = 2000;

let entries = [];
let lastSeq = -1;
let historyPromise = null;
const listeners = new Set();

function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      // One bad listener must not starve the rest.
    }
  });
}

function cap() {
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** A live batch from the 'sidecar:log' channel (ordered, but may overlap history). */
export function ingestSidecarLogEntries(batch) {
  if (!Array.isArray(batch) || !batch.length) return;
  const fresh = batch.filter((e) => e && typeof e.seq === 'number' && e.seq > lastSeq);
  if (!fresh.length) return;
  entries.push(...fresh);
  lastSeq = entries[entries.length - 1].seq;
  cap();
  notify();
}

/**
 * Fetch the main process's ring once (memoized; a failed fetch un-memoizes
 * so a later panel open retries) and merge it under whatever live batches
 * already arrived. Safe to call on every panel open.
 */
export function ensureSidecarLogHistory() {
  if (!historyPromise) {
    historyPromise = getSidecarLogHistory()
      .then((history) => {
        if (!Array.isArray(history) || !history.length) return;
        const known = new Set(entries.map((e) => e.seq));
        const merged = entries.concat(
          history.filter((e) => e && typeof e.seq === 'number' && !known.has(e.seq)),
        );
        merged.sort((a, b) => a.seq - b.seq);
        entries = merged;
        lastSeq = Math.max(lastSeq, entries[entries.length - 1].seq);
        cap();
        notify();
      })
      .catch(() => {
        historyPromise = null;
      });
  }
  return historyPromise;
}

/** Snapshot copy, oldest first. */
export function getSidecarLogEntries() {
  return entries.slice();
}

/** Subscribe to updates (no payload — re-read the snapshot); returns unsubscribe. */
export function onSidecarLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
