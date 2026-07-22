import { resolveServingProfile, acceleratorModels } from '@/util/serving-profile';
import { MODEL_FILES, modelUrl } from '@/util/model-manifest';

// The Serving Profile: the single declared "what this machine wants" —
// models with roles + the EPs a healthy sidecar should reach
// (docs/serving-setup-design.md, Phase 2).

const required = MODEL_FILES.filter((m) => m.required).map((m) => m.file);

describe('resolveServingProfile', () => {
  it('darwin: mac-coreml — required + both CoreML buckets, CoreML expected everywhere', () => {
    const p = resolveServingProfile('darwin');
    expect(p.name).toBe('mac-coreml');
    const byRole = (role) => p.models.filter((m) => m.role === role).map((m) => m.file);
    required.forEach((f) => expect(byRole('required')).toContain(f));
    expect(byRole('accelerator').sort()).toEqual([
      'ant_v2_fp32_bucket.onnx', 'gap_closer_fp32_bucket.onnx',
    ]);
    expect(p.expected).toEqual({ colorize: 'coreml', segment: 'coreml' });
  });

  it('win32: win-dml — tiled-scatter accelerator, DML colorize, CPU segment (no DML gap path yet)', () => {
    const p = resolveServingProfile('win32');
    expect(p.name).toBe('win-dml');
    expect(p.models.filter((m) => m.role === 'accelerator').map((m) => m.file))
      .toEqual(['ant_v2_fp32_tiledscatter.onnx']);
    expect(p.expected).toEqual({ colorize: 'dml', segment: 'cpu' });
  });

  it('anything else: cpu-only — required models only, CPU expected', () => {
    const p = resolveServingProfile('linux');
    expect(p.name).toBe('cpu-only');
    expect(p.models.map((m) => m.file).sort()).toEqual([...required].sort());
    expect(p.models.every((m) => m.role === 'required')).toBe(true);
    expect(p.expected).toEqual({ colorize: 'cpu', segment: 'cpu' });
  });

  it('every entry carries the manifest bytes/sha and a release URL', () => {
    resolveServingProfile('darwin').models.forEach((m) => {
      const manifest = MODEL_FILES.find((f) => f.file === m.file);
      expect(m.bytes).toBe(manifest.bytes);
      expect(m.sha256).toBe(manifest.sha256);
      expect(m.url).toBe(modelUrl(m.file));
    });
  });
});

describe('acceleratorModels', () => {
  it('is the profile filtered to the optional fast-path exports', () => {
    expect(acceleratorModels('darwin').map((m) => m.file).sort()).toEqual([
      'ant_v2_fp32_bucket.onnx', 'gap_closer_fp32_bucket.onnx',
    ]);
    expect(acceleratorModels('linux')).toEqual([]);
  });
});
