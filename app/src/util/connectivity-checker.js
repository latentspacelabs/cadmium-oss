const checkInternetConnected = require('check-internet-connected');

/**
 * Utility class for checking internet connectivity with automatic retry functionality
 */
class ConnectivityChecker {
  constructor() {
    this.intervalId = null;
    this.isChecking = false;
    this.onConnectedCallback = null;
    this.onDisconnectedCallback = null;
  }

  /**
   * Check internet connectivity once (instance method)
   * @returns {Promise<boolean>} true if connected, false if not
   */
  // eslint-disable-next-line class-methods-use-this
  async checkOnce() {
    return ConnectivityChecker.checkOnce();
  }

  /**
   * Check that the serving backend is reachable, once (static method).
   *
   * Every modal.js op calls this before building a request URL, which makes
   * it the "first use" seam for the embedded backend: when the active
   * descriptor is embedded, reachability means "the app-managed sidecar is
   * ready" — sidecar:ensure spawns it on demand (idempotent) and its result
   * carries the runtime port that the URL getters then resolve against. No
   * internet is required for the embedded backend.
   *
   * @returns {Promise<boolean>} true if the backend is usable, false if not
   */
  static async checkOnce() {
    /* eslint-disable global-require */
    const { getServerBackend, BACKEND_EMBEDDED } = require('./server-config');
    if (getServerBackend().kind === BACKEND_EMBEDDED) {
      try {
        const { ensureSidecar } = require('@/platform');
        const status = await ensureSidecar();
        const { updateSidecarStatus } = require('./sidecar-status');
        updateSidecarStatus(status); // records the runtime port for URL building
        const ready = !!(status && status.state === 'ready' && status.port);
        if (!ready) {
          console.log('Embedded sidecar not ready:', status && status.lastError);
        }
        return ready;
      } catch (error) {
        console.log('Embedded sidecar check failed:', error.message);
        return false;
      }
    }
    try {
      await checkInternetConnected();
      return true;
    } catch (error) {
      console.log('No internet connection detected:', error.message);
      return false;
    }
  }

  /**
   * Start automatic connectivity checking with a specified interval
   * @param {number} intervalMs - Interval in milliseconds between checks (default: 5000ms)
   * @param {Function} onConnected - Callback when connectivity is restored
   * @param {Function} onDisconnected - Callback when connectivity is lost
   */
  startAutoCheck(intervalMs = 5000, onConnected = null, onDisconnected = null) {
    if (this.intervalId) {
      this.stopAutoCheck();
    }

    this.onConnectedCallback = onConnected;
    this.onDisconnectedCallback = onDisconnected;
    let wasConnected = null;

    this.intervalId = setInterval(async () => {
      if (this.isChecking) return; // Prevent overlapping checks

      this.isChecking = true;
      try {
        const isConnected = await ConnectivityChecker.checkOnce();

        // Only fire callbacks on state change
        if (wasConnected !== null && wasConnected !== isConnected) {
          if (isConnected && this.onConnectedCallback) {
            this.onConnectedCallback();
          } else if (!isConnected && this.onDisconnectedCallback) {
            this.onDisconnectedCallback();
          }
        }

        wasConnected = isConnected;
      } catch (error) {
        console.error('Error during connectivity check:', error);
      } finally {
        this.isChecking = false;
      }
    }, intervalMs);

    console.log(`Started automatic connectivity checking every ${intervalMs}ms`);
  }

  /**
   * Stop automatic connectivity checking
   */
  stopAutoCheck() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.onConnectedCallback = null;
      this.onDisconnectedCallback = null;
      console.log('Stopped automatic connectivity checking');
    }
  }

  /**
   * Check if auto-checking is currently active
   * @returns {boolean}
   */
  isAutoChecking() {
    return this.intervalId !== null;
  }
}

// Export a singleton instance
const connectivityChecker = new ConnectivityChecker();
export default connectivityChecker;
export { ConnectivityChecker };
