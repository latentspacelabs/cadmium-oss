import { planQuarantine, ORPHAN_DIR } from '@/util/model-hygiene-core';

// Models-dir hygiene (Phase 5): quarantine unknown/wrong-size files, honor
// dev symlinks, never touch directories or dotfiles.

const PROFILE = [
  { file: 'ant_v2_fp32.onnx', bytes: 100 },
  { file: 'gap_closer_fp32.onnx', bytes: 50 },
];

function entry(name, overrides = {}) {
  return {
    name, size: null, isDirectory: false, isSymlink: false, ...overrides,
  };
}

describe('planQuarantine', () => {
  it('keeps profile files at the right size, quarantines wrong sizes', () => {
    const doomed = planQuarantine({
      entries: [
        entry('ant_v2_fp32.onnx', { size: 100 }), // exact — keep
        entry('gap_closer_fp32.onnx', { size: 49 }), // truncated — quarantine
      ],
      profileModels: PROFILE,
    });
    expect(doomed).toEqual(['gap_closer_fp32.onnx']);
  });

  it('quarantines unknown files, including stale .part leftovers', () => {
    const doomed = planQuarantine({
      entries: [
        entry('ant_v2_fp32.onnx', { size: 100 }),
        entry('old_model_v1.onnx', { size: 12345 }),
        entry('gap_closer_fp32.onnx.part', { size: 10 }),
      ],
      profileModels: PROFILE,
    });
    expect(doomed.sort()).toEqual(['gap_closer_fp32.onnx.part', 'old_model_v1.onnx']);
  });

  it('honors symlinks on profile names regardless of size (dev overrides)', () => {
    const doomed = planQuarantine({
      entries: [entry('ant_v2_fp32.onnx', { isSymlink: true, size: null })],
      profileModels: PROFILE,
    });
    expect(doomed).toEqual([]);
  });

  it('never touches directories or dotfiles', () => {
    const doomed = planQuarantine({
      entries: [
        entry(ORPHAN_DIR, { isDirectory: true }),
        entry('.DS_Store', { size: 6148 }),
        entry('some-dir', { isDirectory: true }),
      ],
      profileModels: PROFILE,
    });
    expect(doomed).toEqual([]);
  });

  it('empty input → empty plan', () => {
    expect(planQuarantine({ entries: [], profileModels: PROFILE })).toEqual([]);
    expect(planQuarantine({ entries: undefined, profileModels: PROFILE })).toEqual([]);
  });
});
