// The connectivity gate every modal.js serving request passes through. For a
// hosted backend it is an internet check; for the embedded backend it is the
// "first use" seam that spawns/ensures the sidecar over IPC and records the
// runtime port that the URL getters then resolve against — so modal.js itself
// needs no backend awareness.

jest.mock('check-internet-connected', () => jest.fn());
jest.mock('@/platform', () => ({
  ensureSidecar: jest.fn(),
}));
jest.mock('@/util/server-config', () => {
  const actual = jest.requireActual('@/util/server-config');
  return {
    ...actual,
    getServerBackend: jest.fn(() => ({ kind: 'hosted', baseUrl: 'http://x:8000' })),
    setEmbeddedRuntimePort: jest.fn(),
  };
});

const checkInternetConnected = require('check-internet-connected');
const { ensureSidecar } = require('@/platform');
const serverConfig = require('@/util/server-config');
const { ConnectivityChecker } = require('@/util/connectivity-checker');

describe('ConnectivityChecker.checkOnce — hosted backend', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is an internet check: true when reachable', async () => {
    checkInternetConnected.mockResolvedValue(true);
    await expect(ConnectivityChecker.checkOnce()).resolves.toBe(true);
    expect(ensureSidecar).not.toHaveBeenCalled();
  });

  it('false when the internet check rejects', async () => {
    checkInternetConnected.mockRejectedValue(new Error('offline'));
    await expect(ConnectivityChecker.checkOnce()).resolves.toBe(false);
  });
});

describe('ConnectivityChecker.checkOnce — embedded backend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    serverConfig.getServerBackend.mockReturnValue({ kind: 'embedded', baseUrl: '' });
  });

  it('ensures the sidecar and records its runtime port when ready', async () => {
    ensureSidecar.mockResolvedValue({ state: 'ready', port: 53211, baseUrl: 'http://127.0.0.1:53211' });
    await expect(ConnectivityChecker.checkOnce()).resolves.toBe(true);
    expect(ensureSidecar).toHaveBeenCalledTimes(1);
    // The port reaches server-config (via sidecar-status), so the very next
    // getColorizeUrl()/getSegmentUrl() call resolves to the live sidecar.
    expect(serverConfig.setEmbeddedRuntimePort).toHaveBeenCalledWith(53211);
    // No internet needed for the embedded backend.
    expect(checkInternetConnected).not.toHaveBeenCalled();
  });

  it('reports unusable (and clears the port) when the sidecar failed', async () => {
    ensureSidecar.mockResolvedValue({ state: 'failed', port: null, lastError: 'Missing: ant_v2_fp32.onnx' });
    await expect(ConnectivityChecker.checkOnce()).resolves.toBe(false);
    expect(serverConfig.setEmbeddedRuntimePort).toHaveBeenCalledWith(null);
  });

  it('reports unusable when the IPC call itself blows up', async () => {
    ensureSidecar.mockRejectedValue(new Error('no main process'));
    await expect(ConnectivityChecker.checkOnce()).resolves.toBe(false);
  });
});
