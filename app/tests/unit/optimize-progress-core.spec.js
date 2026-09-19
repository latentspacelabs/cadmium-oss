/* eslint-disable */
import {
  countCompiledPartitions,
  computeOptimizeProgress,
  resolveOptimizePhase,
  healthReportsBuilding,
  statusReportsBuilding,
  healthCapabilityBuilding,
  compilingProgress,
  LOADING_PHASE_MAX_MS,
} from '@/util/optimize-progress-core';

// The CoreML optimization-progress signal: partition counting, percent
// clamping, the compiling-vs-loading phase latch, and the building
// predicates shared by the main process and the renderer.

describe('countCompiledPartitions', () => {
  it('counts only *_mlprogram entries (the real cache dir holds model.txt too)', () => {
    // Shape of the real ant-bucket cache subdir: 42 partitions + model.txt.
    const entries = ['model.txt'];
    for (let i = 0; i < 42; i += 1) entries.push(`${i}_dynamic_mlprogram`);
    expect(countCompiledPartitions(entries)).toBe(42);
  });

  it('ignores unknown names and handles empty/missing listings', () => {
    expect(countCompiledPartitions(['model.txt', '.DS_Store', 'stray'])).toBe(0);
    expect(countCompiledPartitions([])).toBe(0);
    expect(countCompiledPartitions(null)).toBe(0);
  });

  it('matches exactly <N>_dynamic_mlprogram — stray suffix-alikes do not count', () => {
    expect(countCompiledPartitions([
      'old_0_dynamic_mlprogram', // backup copy — no numeric prefix match
      'x_mlprogram',
      '0_dynamic_mlprogram.bak',
      '7_dynamic_mlprogram',
    ])).toBe(1);
  });
});

describe('computeOptimizeProgress', () => {
  it('computes a floor percentage', () => {
    expect(computeOptimizeProgress({ done: 21, total: 42 })).toEqual({ done: 21, total: 42, percent: 50 });
    expect(computeOptimizeProgress({ done: 10, total: 42 }).percent).toBe(23);
  });

  it('clamps at 99 — completion is signaled by the report, never the bar', () => {
    expect(computeOptimizeProgress({ done: 42, total: 42 }).percent).toBe(99);
    // An ORT upgrade can change the partitioning; a stale denominator must
    // not overstate completion.
    expect(computeOptimizeProgress({ done: 45, total: 42 }).percent).toBe(99);
  });

  it('degrades to 0 on a missing/zero total or bogus done', () => {
    expect(computeOptimizeProgress({ done: 5, total: 0 }).percent).toBe(0);
    expect(computeOptimizeProgress({ done: 5, total: undefined }).percent).toBe(0);
    expect(computeOptimizeProgress({ done: NaN, total: 42 })).toEqual({ done: 0, total: 42, percent: 0 });
  });
});

describe('resolveOptimizePhase', () => {
  it('first observation decides: partial set = compiling, full set = loading', () => {
    expect(resolveOptimizePhase(null, { done: 3, total: 42 })).toBe('compiling');
    expect(resolveOptimizePhase(null, { done: 0, total: 42 })).toBe('compiling');
    expect(resolveOptimizePhase(null, { done: 42, total: 42 })).toBe('loading');
    expect(resolveOptimizePhase(null, { done: 45, total: 42 })).toBe('loading');
  });

  it('latches — a compile reaching done===total must not flip to loading', () => {
    expect(resolveOptimizePhase('compiling', { done: 42, total: 42 })).toBe('compiling');
    expect(resolveOptimizePhase('loading', { done: 42, total: 42 })).toBe('loading');
  });

  it('an unknown total reads as compiling (never claims a fast reload)', () => {
    expect(resolveOptimizePhase(null, { done: 0, total: 0 })).toBe('compiling');
  });

  it('a loading episode older than the sanity window re-resolves to compiling', () => {
    // The first observation can be fooled: all partition dirs on disk while
    // ORT still assembles the session. A real reload never runs this long.
    const probe = { done: 42, total: 42 };
    expect(resolveOptimizePhase('loading', probe, LOADING_PHASE_MAX_MS)).toBe('loading');
    expect(resolveOptimizePhase('loading', probe, LOADING_PHASE_MAX_MS + 1)).toBe('compiling');
    // The window never demotes a compiling episode.
    expect(resolveOptimizePhase('compiling', probe, LOADING_PHASE_MAX_MS + 1)).toBe('compiling');
  });
});

describe('healthReportsBuilding / statusReportsBuilding', () => {
  const buildingHealth = {
    acceleration: {
      colorize: { planned: 'coreml', active: 'building', reason: null },
      segment: { planned: 'cpu', active: 'cpu', reason: null },
    },
  };
  const settledHealth = {
    acceleration: {
      colorize: { planned: 'coreml', active: 'coreml', reason: null },
      segment: { planned: 'cpu', active: 'cpu', reason: null },
    },
  };

  it('detects a building capability anywhere in the report', () => {
    expect(healthReportsBuilding(buildingHealth)).toBe(true);
    expect(healthReportsBuilding(settledHealth)).toBe(false);
    expect(healthReportsBuilding(null)).toBe(false);
    expect(healthReportsBuilding({})).toBe(false);
  });

  it('statusReportsBuilding requires a ready status with a building report', () => {
    expect(statusReportsBuilding({ state: 'ready', health: buildingHealth })).toBe(true);
    expect(statusReportsBuilding({ state: 'ready', health: settledHealth })).toBe(false);
    expect(statusReportsBuilding({ state: 'starting', health: buildingHealth })).toBe(false);
    expect(statusReportsBuilding({ state: 'ready', health: null })).toBe(false);
    expect(statusReportsBuilding(null)).toBe(false);
  });

  it('healthCapabilityBuilding checks one capability, not any', () => {
    expect(healthCapabilityBuilding(buildingHealth, 'colorize')).toBe(true);
    expect(healthCapabilityBuilding(buildingHealth, 'segment')).toBe(false);
    expect(healthCapabilityBuilding(settledHealth, 'colorize')).toBe(false);
    expect(healthCapabilityBuilding(null, 'colorize')).toBe(false);
  });

  it('compilingProgress selects the optimizing signal only for a real compile', () => {
    const compiling = { phase: 'compiling', done: 10, total: 42, percent: 23, sinceMs: 0 };
    expect(compilingProgress({ optimizing: compiling })).toBe(compiling);
    expect(compilingProgress({ optimizing: { ...compiling, phase: 'loading' } })).toBeNull();
    expect(compilingProgress({ optimizing: null })).toBeNull();
    expect(compilingProgress(null)).toBeNull();
  });
});
