import { buildSegMapFileName } from '@/util/segmap-path';

// buildSegMapFileName produces the deterministic on-disk cache name for a
// segmentation map. The exact format is a cache KEY: if it drifts, previously
// segmented frames silently miss and get re-segmented. These tests pin the
// format and the parameter encoding (shared by COLORIZE target+ref and ANALYZE).

const base = {
  hash: 'abc123',
  lineThreshold: 12,
  isAutoAlpha: false,
  tbDilationSize: 4,
  aiDilationSize: 0,
  minSegSize: 2,
};

describe('buildSegMapFileName', () => {
  it('produces the exact golden filename for a manual-threshold request', () => {
    expect(buildSegMapFileName(base)).toBe(
      'cadm_segMap_abc123_line_threshold_12_tbDilate_04_aiDilate_00_minSegSize_2.png',
    );
  });

  it('uses the literal "auto" in the threshold slot when isAutoAlpha is set', () => {
    const name = buildSegMapFileName({ ...base, isAutoAlpha: true, lineThreshold: 99 });
    expect(name).toBe(
      'cadm_segMap_abc123_line_threshold_auto_tbDilate_04_aiDilate_00_minSegSize_2.png',
    );
    // the numeric lineThreshold must be ignored entirely in auto mode
    expect(name).not.toContain('99');
  });

  it('zero-pads dilation sizes to two digits', () => {
    expect(buildSegMapFileName({ ...base, tbDilationSize: 4, aiDilationSize: 7 }))
      .toContain('_tbDilate_04_aiDilate_07_');
    expect(buildSegMapFileName({ ...base, tbDilationSize: 12, aiDilationSize: 30 }))
      .toContain('_tbDilate_12_aiDilate_30_');
  });

  it('does not truncate dilation sizes wider than two digits', () => {
    expect(buildSegMapFileName({ ...base, tbDilationSize: 100 }))
      .toContain('_tbDilate_100_');
  });

  it('passes minSegSize through verbatim', () => {
    expect(buildSegMapFileName({ ...base, minSegSize: 25 })).toContain('_minSegSize_25.png');
  });

  it('is stable — identical inputs yield identical names (cache-hit invariant)', () => {
    expect(buildSegMapFileName(base)).toBe(buildSegMapFileName({ ...base }));
  });

  it('varies the name when any cache-relevant parameter changes', () => {
    const ref = buildSegMapFileName(base);
    expect(buildSegMapFileName({ ...base, hash: 'zzz999' })).not.toBe(ref);
    expect(buildSegMapFileName({ ...base, lineThreshold: 13 })).not.toBe(ref);
    expect(buildSegMapFileName({ ...base, tbDilationSize: 5 })).not.toBe(ref);
    expect(buildSegMapFileName({ ...base, aiDilationSize: 1 })).not.toBe(ref);
    expect(buildSegMapFileName({ ...base, minSegSize: 3 })).not.toBe(ref);
  });
});
