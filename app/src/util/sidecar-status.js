/* eslint-disable */
/**
 * Renderer-side cache of the embedded sidecar's status.
 *
 * The main process pushes every state transition on the 'sidecar:status' IPC
 * channel; ipc-renderer-handlers.js funnels those pushes (and the results of
 * explicit sidecar:ensure/status calls) into updateSidecarStatus(). UI that
 * wants live status (ServerSettingsModal) subscribes here instead of owning
 * an IPC listener — removeListeners() on a shared channel would tear down
 * everyone's subscription, this module's callbacks don't.
 *
 * Status shape (see sidecar-manager.js getStatus): { state, port, baseUrl,
 * pid, lastError, missing, restarts, binPath, modelsDir }. Session-local
 * runtime info only — never persisted, never document state.
 */

import { setEmbeddedRuntimePort } from './server-config';

let current = null;
const listeners = new Set();

export function updateSidecarStatus(status) {
  current = status || null;
  // Keep the URL layer in lockstep: serving requests resolve the embedded
  // base URL from this port (util/server-config.js getServerBaseUrl).
  setEmbeddedRuntimePort(status && status.state === 'ready' ? status.port : null);
  listeners.forEach((fn) => {
    try {
      fn(current);
    } catch (e) {
      // One bad listener must not starve the rest.
    }
  });
}

export function getLastSidecarStatus() {
  return current;
}

/** Subscribe to status updates; returns an unsubscribe function. */
export function onSidecarStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
