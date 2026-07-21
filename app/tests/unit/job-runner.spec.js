// Tests for the JobRunner service (architecture doc §3.3, bug factory F1).
//
// The runner is pure coordination logic: it takes a store-like `{ commit }` and
// mirrors job state into the legacy Vuex mutations. We drive it with a stub
// store that records every commit, so the mirror table, the start/settle
// sequences, cancellation, and error handling are all asserted without Vuex.

import {
  runJob,
  cancelJob,
  currentJob,
  isJobRunning,
  JobAlreadyRunningError,
  JobCanceledError,
  JOB_MIRRORS,
} from '@/services/job-runner';

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

function makeStore() {
  const commits = [];
  return {
    commits,
    commit: (type, payload) => { commits.push({ type, payload }); },
    // convenience: the (type, payload) pairs as tuples, for order assertions
    types: () => commits.map(c => c.type),
  };
}

// A promise you can resolve/reject from the outside — to hold a job "pending".
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Safety net: make sure no test leaks the module-singleton in-flight job into
// the next test even if it fails mid-flight.
afterEach(async () => {
  if (isJobRunning()) {
    cancelJob(makeStore());
    // give any pending executor a tick to settle
    await new Promise(r => setTimeout(r, 0));
  }
});

describe('runJob — exclusivity', () => {
  it('rejects a second job while the first is still pending', async () => {
    const store = makeStore();
    const gate = deferred();

    const first = runJob(store, { name: 'colorize' }, () => gate.promise);
    expect(isJobRunning()).toBe(true);
    expect(currentJob().name).toBe('colorize');

    await expect(runJob(store, { name: 'export' }, async () => 'nope'))
      .rejects.toBeInstanceOf(JobAlreadyRunningError);

    gate.resolve('done');
    await first;
    expect(isJobRunning()).toBe(false);
    expect(currentJob()).toBeNull();
  });

  it('allows a new job once the first has settled', async () => {
    const store = makeStore();
    await runJob(store, { name: 'colorize' }, async () => 'a');
    const result = await runJob(store, { name: 'export' }, async () => 'b');
    expect(result).toBe('b');
  });

  it('throws on an unknown job name', async () => {
    const store = makeStore();
    await expect(runJob(store, { name: 'bogus' }, async () => 1)).rejects.toThrow(/Unknown job name/);
    expect(isJobRunning()).toBe(false);
  });
});

describe('runJob — mirror table (start / progress / settle sequences)', () => {
  const cases = [
    {
      name: 'colorize',
      inProgress: SET_COLORIZATION_IN_PROGRESS,
      task: TASK_COLORIZATION,
      progress: SET_COLORIZATION_PROGRESS,
      canceled: SET_COLORIZATION_CANCELED_BY_USER,
    },
    {
      name: 'analyze',
      inProgress: SET_COLORIZATION_IN_PROGRESS,
      task: TASK_SEGMENTATION_MAP_GENERATION,
      progress: SET_COLORIZATION_PROGRESS,
      canceled: SET_COLORIZATION_CANCELED_BY_USER,
    },
    {
      name: 'export',
      inProgress: SET_EXPORT_IN_PROGRESS,
      task: TASK_EXPORT,
      progress: SET_EXPORT_PROGRESS,
      canceled: SET_EXPORT_CANCELED_BY_USER,
    },
    {
      name: 'update-colors',
      inProgress: SET_UPDATE_COLORS_IN_PROGRESS,
      task: TASK_COLOR_UPDATE,
      progress: SET_UPDATED_COLORS_PROGRESS,
      canceled: SET_UPDATE_COLORS_CANCELED_BY_USER,
    },
    {
      name: 'import',
      inProgress: null, // import has no dedicated in-progress flag
      task: TASK_IMPORT_COLOR_NO_LINE,
      progress: SET_COLORIZATION_PROGRESS,
      canceled: SET_ANALYZE_CANCELED_BY_USER,
    },
  ];

  cases.forEach((c) => {
    it(`mirrors "${c.name}" start, progress and settle to the right mutations`, async () => {
      const store = makeStore();

      await runJob(store, { name: c.name }, async (ctx) => {
        // mid-job progress
        ctx.progress(2, 5);
        return 'ok';
      });

      // start: (in-progress true if any), then task
      const expectedStart = [];
      if (c.inProgress) { expectedStart.push({ type: c.inProgress, payload: true }); }
      expectedStart.push({ type: SET_CURRENT_PROCESSING_TASK, payload: c.task });

      // progress commit maps (numFinished, numTotal) -> { numTotal, numFinished }
      const progressCommit = { type: c.progress, payload: { numTotal: 5, numFinished: 2 } };

      // settle: (in-progress false if any), task NONE, progress {0,0}, canceled false
      const expectedSettle = [];
      if (c.inProgress) { expectedSettle.push({ type: c.inProgress, payload: false }); }
      expectedSettle.push({ type: SET_CURRENT_PROCESSING_TASK, payload: TASK_NONE });
      expectedSettle.push({ type: c.progress, payload: { numTotal: 0, numFinished: 0 } });
      expectedSettle.push({ type: c.canceled, payload: false });

      expect(store.commits).toEqual([...expectedStart, progressCommit, ...expectedSettle]);
    });
  });

  it('setEstTimeRemaining commits the progress mutation with { timeRemaining }', async () => {
    const store = makeStore();
    await runJob(store, { name: 'colorize' }, async (ctx) => {
      ctx.setEstTimeRemaining(42);
    });
    expect(store.commits).toContainEqual({
      type: SET_COLORIZATION_PROGRESS,
      payload: { timeRemaining: 42 },
    });
  });

  it('the exported mirror table matches the documented job kinds', () => {
    expect(Object.keys(JOB_MIRRORS).sort()).toEqual(
      ['analyze', 'colorize', 'export', 'import', 'update-colors'],
    );
  });
});

describe('cancelJob', () => {
  it('aborts the signal, commits the legacy canceled mutation, and resolves { canceled: true }', async () => {
    const store = makeStore();
    let seenAbort = false;

    const job = runJob(store, { name: 'export' }, async (ctx) => {
      // simulate a loop that polls the signal
      await new Promise(r => setTimeout(r, 0));
      seenAbort = ctx.signal.aborted;
      return 'should-be-ignored';
    });

    const didCancel = cancelJob(store);
    expect(didCancel).toBe(true);

    const result = await job;
    expect(result).toEqual({ canceled: true });
    expect(seenAbort).toBe(true);

    // the legacy mid-loop poll flag was committed true by cancelJob
    expect(store.commits).toContainEqual({
      type: SET_EXPORT_CANCELED_BY_USER,
      payload: true,
    });
    // ...and reset false on settle
    expect(store.commits.filter(c => c.type === SET_EXPORT_CANCELED_BY_USER))
      .toEqual([{ type: SET_EXPORT_CANCELED_BY_USER, payload: true },
        { type: SET_EXPORT_CANCELED_BY_USER, payload: false }]);
  });

  it('commits the analyze flag for a running import job', async () => {
    const store = makeStore();
    const gate = deferred();
    const job = runJob(store, { name: 'import' }, () => gate.promise);

    cancelJob(store);
    expect(store.commits).toContainEqual({
      type: SET_ANALYZE_CANCELED_BY_USER,
      payload: true,
    });

    gate.resolve();
    await job;
  });

  it('is a no-op when no job is running', () => {
    const store = makeStore();
    expect(cancelJob(store)).toBe(false);
    expect(store.commits).toEqual([]);
  });
});

describe('runJob — throwIfAborted', () => {
  it('throws JobCanceledError after a cancel and still resolves { canceled: true }', async () => {
    const store = makeStore();
    let thrown = null;

    const job = runJob(store, { name: 'colorize' }, async (ctx) => {
      await new Promise(r => setTimeout(r, 0));
      try {
        ctx.throwIfAborted();
      } catch (e) {
        thrown = e;
        throw e;
      }
      return 'unreached';
    });

    cancelJob(store);
    const result = await job;

    expect(thrown).toBeInstanceOf(JobCanceledError);
    expect(result).toEqual({ canceled: true });
  });

  it('does not throw while the job is live', async () => {
    const store = makeStore();
    const result = await runJob(store, { name: 'colorize' }, async (ctx) => {
      ctx.throwIfAborted();
      return 'fine';
    });
    expect(result).toBe('fine');
  });
});

describe('runJob — error path', () => {
  it('resets every mirror then rethrows a real error', async () => {
    const store = makeStore();
    const boom = new Error('kaboom');

    await expect(runJob(store, { name: 'update-colors' }, async () => { throw boom; }))
      .rejects.toBe(boom);

    // settle still ran (finally): the tail of commits is the full reset
    expect(store.commits).toEqual([
      { type: SET_UPDATE_COLORS_IN_PROGRESS, payload: true },
      { type: SET_CURRENT_PROCESSING_TASK, payload: TASK_COLOR_UPDATE },
      { type: SET_UPDATE_COLORS_IN_PROGRESS, payload: false },
      { type: SET_CURRENT_PROCESSING_TASK, payload: TASK_NONE },
      { type: SET_UPDATED_COLORS_PROGRESS, payload: { numTotal: 0, numFinished: 0 } },
      { type: SET_UPDATE_COLORS_CANCELED_BY_USER, payload: false },
    ]);
    expect(isJobRunning()).toBe(false);
  });
});
