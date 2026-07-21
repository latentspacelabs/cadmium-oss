/* eslint-disable max-classes-per-file */
/**
 * job-runner — the single coordinator for long-running operations
 * (architecture doc §3.3, bug factory F1: "global mode flags with temporal
 * coupling").
 *
 * Today ~10 root Vuex flags (`colorizationInProgress`, `exportInProgress`,
 * `updateColorsInProgress`, the four `*CanceledByUser` booleans,
 * `currentProcessingTask`, and the three progress objects) are written by one
 * action and polled by another dispatched later. That temporal coupling is the
 * bug factory. This module becomes the single WRITER of the start/settle
 * coordination state; during this migration phase the legacy flags are kept as
 * read-compatible MIRRORS so every existing reader (waiting-screen overlay,
 * cancel button, progress bar, and the mid-loop cancellation polls that phases
 * 4-5 will delete) keeps working unchanged.
 *
 * The `store` argument is anything with a Vuex `.commit` — a real `Vuex.Store`
 * or the `{ commit }` slice of the context object handed to an action — so the
 * state machine and mirror table are testable without Vuex, like asset-store.js.
 *
 * ── Mirror table ────────────────────────────────────────────────────────────
 * For each job name, which existing mutations mirror the coordination state.
 * (Mutation payload shapes, read from the current actions:
 *   SET_*_IN_PROGRESS(boolean); SET_CURRENT_PROCESSING_TASK(TASK_*);
 *   SET_COLORIZATION_PROGRESS / SET_UPDATED_COLORS_PROGRESS /
 *   SET_EXPORT_PROGRESS({ numTotal, numFinished[, timeRemaining] });
 *   SET_*_CANCELED_BY_USER(boolean).)
 *
 * Columns: inProgress | task-at-start | progress | canceled. `*` below is the
 * job's own prefix (COLORIZATION / EXPORT / UPDATE_COLORS).
 *
 *   colorize       COLORIZATION_IN_PROGRESS | COLORIZATION  | COLORIZATION_PROGRESS
 *                    | COLORIZATION_CANCELED_BY_USER
 *   analyze        COLORIZATION_IN_PROGRESS | SEGMENTATION_MAP_GENERATION
 *                    | COLORIZATION_PROGRESS | COLORIZATION_CANCELED_BY_USER
 *   export         EXPORT_IN_PROGRESS | EXPORT | EXPORT_PROGRESS
 *                    | EXPORT_CANCELED_BY_USER
 *   update-colors  UPDATE_COLORS_IN_PROGRESS | COLOR_UPDATE | UPDATED_COLORS_PROGRESS
 *                    | UPDATE_COLORS_CANCELED_BY_USER
 *   import         (none — see note) | IMPORT_COLOR_NO_LINE | COLORIZATION_PROGRESS
 *                    | ANALYZE_CANCELED_BY_USER
 *
 * Notes on the two subtle rows:
 *  - `analyze` is COLORIZE run with `analyzeModeOnly`. It shares the SAME
 *    `colorizationInProgress` flag and — crucially — the COLORIZE loop polls
 *    `COLORIZATION_CANCELED_BY_USER` in BOTH modes, so that (not the analyze
 *    flag) is what a cancel must trip. The only mode difference is the task
 *    label (analyze => the "Analyzing Frame" TASK_SEGMENTATION_MAP_GENERATION).
 *  - `import` (ADD_IMAGES_TO_TIMELINE) has NO dedicated in-progress flag: the
 *    per-frame overlay is toggled deep inside the shared ANALYZE_CURRENT_FRAME
 *    sub-action, and a LINE-only import must NOT raise the overlay at all.
 *    So the runner deliberately does not touch any in-progress flag for import
 *    (`inProgress: null`); it still owns the task label, progress reset, and the
 *    analyze cancel flag its loop polls (ADD_IMAGES_TO_TIMELINE).
 */

import {
  SET_COLORIZATION_IN_PROGRESS,
  SET_UPDATE_COLORS_IN_PROGRESS,
  SET_EXPORT_IN_PROGRESS,
  SET_COLORIZATION_PROGRESS,
  SET_UPDATED_COLORS_PROGRESS,
  SET_EXPORT_PROGRESS,
  SET_COLORIZATION_CANCELED_BY_USER,
  SET_UPDATE_COLORS_CANCELED_BY_USER,
  SET_ANALYZE_CANCELED_BY_USER,
  SET_EXPORT_CANCELED_BY_USER,
  SET_CURRENT_PROCESSING_TASK,
} from '@/store/mutation-types';

import {
  TASK_COLORIZATION,
  TASK_SEGMENTATION_MAP_GENERATION,
  TASK_EXPORT,
  TASK_COLOR_UPDATE,
  TASK_IMPORT_COLOR_NO_LINE,
  TASK_NONE,
} from '@/store/general-types';

/**
 * The per-name mirror table (see module header). `inProgress` is nullable: a
 * job with no dedicated in-progress flag (import) leaves that mirror alone.
 */
export const JOB_MIRRORS = {
  colorize: {
    inProgress: SET_COLORIZATION_IN_PROGRESS,
    task: TASK_COLORIZATION,
    progress: SET_COLORIZATION_PROGRESS,
    canceled: SET_COLORIZATION_CANCELED_BY_USER,
  },
  analyze: {
    inProgress: SET_COLORIZATION_IN_PROGRESS,
    task: TASK_SEGMENTATION_MAP_GENERATION,
    progress: SET_COLORIZATION_PROGRESS,
    canceled: SET_COLORIZATION_CANCELED_BY_USER,
  },
  export: {
    inProgress: SET_EXPORT_IN_PROGRESS,
    task: TASK_EXPORT,
    progress: SET_EXPORT_PROGRESS,
    canceled: SET_EXPORT_CANCELED_BY_USER,
  },
  'update-colors': {
    inProgress: SET_UPDATE_COLORS_IN_PROGRESS,
    task: TASK_COLOR_UPDATE,
    progress: SET_UPDATED_COLORS_PROGRESS,
    canceled: SET_UPDATE_COLORS_CANCELED_BY_USER,
  },
  import: {
    inProgress: null,
    task: TASK_IMPORT_COLOR_NO_LINE,
    progress: SET_COLORIZATION_PROGRESS,
    canceled: SET_ANALYZE_CANCELED_BY_USER,
  },
};

/**
 * Thrown by `runJob` when a job is already running. Preserves the exclusivity
 * that `currentProcessingTask` implied — one long operation at a time.
 */
export class JobAlreadyRunningError extends Error {
  constructor(runningName, requestedName) {
    super(`Cannot start job "${requestedName}": job "${runningName}" is already running.`);
    this.name = 'JobAlreadyRunningError';
    this.runningJobName = runningName;
    this.requestedJobName = requestedName;
  }
}

/**
 * Typed cancellation signal. `ctx.throwIfAborted()` throws this after a cancel,
 * and `runJob` treats it (like an aborted signal) as a clean cancel rather than
 * an error — it resolves `{ canceled: true }` instead of rejecting.
 */
export class JobCanceledError extends Error {
  constructor(name) {
    super(`Job "${name}" was canceled.`);
    this.name = 'JobCanceledError';
    this.jobName = name;
  }
}

// --- module-singleton state: the one in-flight job, or null ---
//
// The runner is a process-wide coordinator (there is a single overlay / single
// user), so the in-flight job lives in module scope. `runJob` writes it, the
// `finally` clears it, `cancelJob` reads it. Kept intentionally tiny.
let currentJobState = null;

/**
 * @returns {{ name: string, startedAt: number } | null} the in-flight job.
 */
export function currentJob() {
  if (!currentJobState) { return null; }
  return { name: currentJobState.name, startedAt: currentJobState.startedAt };
}

/**
 * @returns {boolean} whether a job is currently running.
 */
export function isJobRunning() {
  return currentJobState !== null;
}

/**
 * Run a long operation as the exclusive job, mirroring its coordination state
 * into the legacy Vuex flags so all current readers keep working.
 *
 * On start: commits the job's `SET_*_IN_PROGRESS(true)` (when it has one) and
 * `SET_CURRENT_PROCESSING_TASK(TASK_*)`. On settle (always, via `finally`):
 * resets the in-progress flag, task to `TASK_NONE`, progress to
 * `{ numTotal: 0, numFinished: 0 }`, and the job's canceled flag to false —
 * so a flow that FORGOT one of those on an error/early-return path can no
 * longer leak it.
 *
 * A cancel (via `cancelJob`, or `ctx.throwIfAborted()` after one) resolves
 * `{ canceled: true }` rather than rejecting. A real error resets the mirrors
 * (in `finally`) then rethrows.
 *
 * @param {Object} store - Vuex store or action context ({ commit }).
 * @param {Object} opts
 * @param {('colorize'|'analyze'|'export'|'update-colors'|'import')} opts.name
 * @param {(ctx: JobContext) => Promise<*>} executor
 * @returns {Promise<*|{ canceled: true }>}
 * @throws {JobAlreadyRunningError}
 */
export async function runJob(store, { name }, executor) {
  const mirror = JOB_MIRRORS[name];
  if (!mirror) { throw new Error(`Unknown job name: ${name}`); }
  if (currentJobState) { throw new JobAlreadyRunningError(currentJobState.name, name); }

  const controller = new AbortController();
  const { signal } = controller;
  currentJobState = { name, startedAt: Date.now(), controller };

  // start mirrors
  if (mirror.inProgress) { store.commit(mirror.inProgress, true); }
  store.commit(SET_CURRENT_PROCESSING_TASK, mirror.task);

  /**
   * @typedef {Object} JobContext
   * @property {AbortSignal} signal
   * @property {() => void} throwIfAborted - throws JobCanceledError if aborted.
   * @property {(numFinished: number, numTotal: number) => void} progress
   * @property {(seconds: number) => void} setEstTimeRemaining
   */
  const ctx = {
    signal,
    throwIfAborted() {
      if (signal.aborted) { throw new JobCanceledError(name); }
    },
    progress(numFinished, numTotal) {
      store.commit(mirror.progress, { numTotal, numFinished });
    },
    setEstTimeRemaining(seconds) {
      store.commit(mirror.progress, { timeRemaining: seconds });
    },
  };

  try {
    const result = await executor(ctx);
    if (signal.aborted) { return { canceled: true }; }
    return result;
  } catch (err) {
    if (err instanceof JobCanceledError || signal.aborted) { return { canceled: true }; }
    throw err;
  } finally {
    // settle mirrors — always, so no path can leak the coordination state
    if (mirror.inProgress) { store.commit(mirror.inProgress, false); }
    store.commit(SET_CURRENT_PROCESSING_TASK, TASK_NONE);
    store.commit(mirror.progress, { numTotal: 0, numFinished: 0 });
    store.commit(mirror.canceled, false);
    currentJobState = null;
  }
}

/**
 * Request cancellation of the in-flight job: aborts its AbortController AND
 * commits the matching legacy `SET_*_CANCELED_BY_USER(true)` mutation, so the
 * existing mid-loop polls (which phases 4-5 will remove) still trip. No-op when
 * no job is running.
 *
 * @param {Object} store - Vuex store or action context ({ commit }).
 * @returns {boolean} whether a job was running and got canceled.
 */
export function cancelJob(store) {
  if (!currentJobState) { return false; }
  currentJobState.controller.abort();
  const mirror = JOB_MIRRORS[currentJobState.name];
  store.commit(mirror.canceled, true);
  return true;
}
