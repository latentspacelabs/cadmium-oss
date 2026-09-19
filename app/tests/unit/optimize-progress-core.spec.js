/* eslint-disable */
import {
  countCompiledPartitions,
  computeOptimizeProgress,
  resolveOptimizePhase,
  healthReportsBuilding,
  statusReportsBuilding,
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
});
