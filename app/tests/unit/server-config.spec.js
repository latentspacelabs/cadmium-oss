import {
  DEFAULT_SERVER_URL,
  BACKEND_HOSTED,
  BACKEND_EMBEDDED,
  EMBEDDED_UNAVAILABLE_URL,
  normalizeServerUrl,
  coerceServerBackend,
  legacyServerUrlToBackend,
  resolveServerBackend,
  resolveBackendBaseUrl,
  embeddedBaseUrl,
  setEmbeddedRuntimePort,
  getEmbeddedRuntimePort,
  getServerBackend,
  getServerBaseUrl,
  getColorizeUrl,
  getSegmentUrl,
  getPreprocessUrl,
  getHealthUrl,
} from '@/util/server-config';

import mutations from '@/store/mutations';
import { SET_SERVER_BACKEND } from '@/store/mutation-types';

// The backend descriptor { kind, baseUrl } is what tells the app where ML
// serving lives; every /colorize /segment /preprocess request resolves its
// URL through it. These tests pin the descriptor validation, the migration of
// the legacy `serverUrl` string pref, and the URL resolution chain.

describe('normalizeServerUrl', () => {
  it('trims whitespace and strips trailing slashes', () => {
    expect(normalizeServerUrl('  http://foo:8000/  ')).toBe('http://foo:8000');
    expect(normalizeServerUrl('http://foo:8000///')).toBe('http://foo:8000');
  });

  it('maps null/undefined to the empty string', () => {
    expect(normalizeServerUrl(null)).toBe('');
    expect(normalizeServerUrl(undefined)).toBe('');
  });
});

describe('coerceServerBackend', () => {
  it('accepts a valid hosted descriptor and normalizes its baseUrl', () => {
    expect(coerceServerBackend({ kind: 'hosted', baseUrl: 'http://foo:8000/' }))
      .toEqual({ kind: BACKEND_HOSTED, baseUrl: 'http://foo:8000' });
  });

  it('accepts an embedded descriptor without a baseUrl', () => {
    expect(coerceServerBackend({ kind: 'embedded', baseUrl: '' }))
      .toEqual({ kind: BACKEND_EMBEDDED, baseUrl: '' });
  });

  it('rejects a hosted descriptor without a baseUrl', () => {
    expect(coerceServerBackend({ kind: 'hosted', baseUrl: '' })).toBeNull();
    expect(coerceServerBackend({ kind: 'hosted', baseUrl: '   ' })).toBeNull();
  });

  it('rejects unknown kinds and non-objects', () => {
    expect(coerceServerBackend({ kind: 'modal', baseUrl: 'http://x' })).toBeNull();
    expect(coerceServerBackend('http://foo:8000')).toBeNull();
    expect(coerceServerBackend(null)).toBeNull();
    expect(coerceServerBackend(undefined)).toBeNull();
  });

  it('drops extra fields so only { kind, baseUrl } is stored', () => {
    const coerced = coerceServerBackend({ kind: 'hosted', baseUrl: 'http://x', junk: 1 });
    expect(coerced).toEqual({ kind: BACKEND_HOSTED, baseUrl: 'http://x' });
  });

  it('strips any baseUrl off an embedded descriptor (the port is runtime-only)', () => {
    // A stale port persisted by an old build or carried in from elsewhere
    // must never resurface: the main process owns the port at spawn time.
    expect(coerceServerBackend({ kind: 'embedded', baseUrl: 'http://127.0.0.1:53211' }))
      .toEqual({ kind: BACKEND_EMBEDDED, baseUrl: '' });
  });
});

describe('legacyServerUrlToBackend', () => {
  it('migrates a legacy serverUrl string to a hosted descriptor', () => {
    expect(legacyServerUrlToBackend('http://wallace:8000/'))
      .toEqual({ kind: BACKEND_HOSTED, baseUrl: 'http://wallace:8000' });
  });

  it('returns null for unset/blank legacy values', () => {
    expect(legacyServerUrlToBackend('')).toBeNull();
    expect(legacyServerUrlToBackend('   ')).toBeNull();
    expect(legacyServerUrlToBackend(null)).toBeNull();
    expect(legacyServerUrlToBackend(undefined)).toBeNull();
  });
});

describe('resolveServerBackend', () => {
  it('prefers a valid descriptor pref over everything else', () => {
    const backend = resolveServerBackend(
      { kind: 'hosted', baseUrl: 'http://pref:8000' },
      'http://legacy:8000',
      'http://env:8000',
    );
    expect(backend).toEqual({ kind: BACKEND_HOSTED, baseUrl: 'http://pref:8000' });
  });

  it('falls back to the migrated legacy pref when no descriptor is set', () => {
    expect(resolveServerBackend(null, 'http://legacy:8000/', 'http://env:8000'))
      .toEqual({ kind: BACKEND_HOSTED, baseUrl: 'http://legacy:8000' });
  });

  it('falls through an INVALID descriptor to the legacy pref', () => {
    expect(resolveServerBackend({ kind: 'nope' }, 'http://legacy:8000', null))
      .toEqual({ kind: BACKEND_HOSTED, baseUrl: 'http://legacy:8000' });
  });

  it('uses the build-time env URL when no pref is set', () => {
    expect(resolveServerBackend(null, null, 'http://env:8000'))
      .toEqual({ kind: BACKEND_HOSTED, baseUrl: 'http://env:8000' });
  });

  it('defaults to hosted localhost:8000 when nothing is configured', () => {
    expect(resolveServerBackend(null, null, undefined))
      .toEqual({ kind: BACKEND_HOSTED, baseUrl: DEFAULT_SERVER_URL });
  });
});

describe('embedded runtime base URL', () => {
  afterEach(() => setEmbeddedRuntimePort(null));

  it('embeddedBaseUrl maps a port to loopback and no port to the fail-fast placeholder', () => {
    expect(embeddedBaseUrl(53211)).toBe('http://127.0.0.1:53211');
    expect(embeddedBaseUrl(null)).toBe(EMBEDDED_UNAVAILABLE_URL);
  });

  it('resolveBackendBaseUrl: hosted uses its own baseUrl, embedded the runtime port', () => {
    const hosted = { kind: BACKEND_HOSTED, baseUrl: 'http://wallace:8000' };
    const embedded = { kind: BACKEND_EMBEDDED, baseUrl: '' };
    expect(resolveBackendBaseUrl(hosted, 53211)).toBe('http://wallace:8000');
    expect(resolveBackendBaseUrl(embedded, 53211)).toBe('http://127.0.0.1:53211');
    // Sidecar not up yet: fail fast, never fall back to the hosted default.
    expect(resolveBackendBaseUrl(embedded, null)).toBe(EMBEDDED_UNAVAILABLE_URL);
    expect(resolveBackendBaseUrl(null, null)).toBe(DEFAULT_SERVER_URL);
  });

  it('set/getEmbeddedRuntimePort round-trips and clears', () => {
    setEmbeddedRuntimePort(53211);
    expect(getEmbeddedRuntimePort()).toBe(53211);
    setEmbeddedRuntimePort(null);
    expect(getEmbeddedRuntimePort()).toBeNull();
  });

  it('the runtime port does not leak into hosted URL resolution', () => {
    setEmbeddedRuntimePort(53211);
    // Under jest the resolved backend is the hosted default; the recorded
    // embedded port must not affect it.
    expect(getServerBaseUrl()).toBe(DEFAULT_SERVER_URL);
  });
});

describe('URL resolution (no prefs available under jest)', () => {
  // Outside an Electron renderer the pref read fails silently, so resolution
  // lands on env/default — which is exactly what these tests pin.
  it('getServerBackend returns the default hosted descriptor', () => {
    expect(getServerBackend()).toEqual({ kind: BACKEND_HOSTED, baseUrl: DEFAULT_SERVER_URL });
  });

  it('op URLs are paths on the resolved base URL', () => {
    expect(getServerBaseUrl()).toBe(DEFAULT_SERVER_URL);
    expect(getColorizeUrl()).toBe(`${DEFAULT_SERVER_URL}/colorize`);
    expect(getSegmentUrl()).toBe(`${DEFAULT_SERVER_URL}/segment`);
    expect(getPreprocessUrl()).toBe(`${DEFAULT_SERVER_URL}/preprocess`);
    expect(getHealthUrl()).toBe(`${DEFAULT_SERVER_URL}/health`);
  });
});

describe('SET_SERVER_BACKEND mutation', () => {
  it('replaces the descriptor on the state', () => {
    const state = { serverBackend: { kind: BACKEND_HOSTED, baseUrl: DEFAULT_SERVER_URL } };
    const backend = { kind: BACKEND_HOSTED, baseUrl: 'http://wallace:8000' };
    mutations[SET_SERVER_BACKEND](state, backend);
    expect(state.serverBackend).toEqual(backend);
  });
});
