/* eslint-disable */
/**
 * Renderer-side cache of the model download progress, mirroring
 * sidecar-status.js: the main process pushes every snapshot on the
 * 'sidecar:models-progress' IPC channel; ipc-renderer-handlers.js funnels
 * them here, and UI (ServerSettingsModal) subscribes via callbacks instead
 * of owning IPC listeners.
 *
 * Snapshot shape (util/model-download-core.js progressSnapshot): { state,
 * file, fileIndex, fileCount, receivedBytes, totalBytes, error }.
 */

let current = { state: 'idle', file: null, fileIndex: 0, fileCount: 0, receivedBytes: 0, totalBytes: 0, error: null };
const listeners = new Set();

export function updateModelDownloadProgress(progress) {
  if (!progress) return;
  current = progress;
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (e) {
      // One bad listener must not starve the rest.
    }
  });
}

export function getLastModelDownloadProgress() {
  return current;
}

/** Subscribe to progress updates; returns an unsubscribe function. */
export function onModelDownloadProgress(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
