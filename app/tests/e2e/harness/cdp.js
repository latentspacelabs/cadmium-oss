/*
 * Minimal CDP client for the Cadmium e2e harness.
 *
 * Talks to the Electron MAIN process through the node inspector on :9229
 * (opened with `kill -USR1 <electron pid>` — no restart, no build flags).
 * Renderer code runs through webContents.executeJavaScript, so nothing in
 * the app needs test instrumentation.
 *
 * All eval results must be JSON-serializable (returnByValue).
 */
const http = require('http');
const WebSocket = require('ws');

const INSPECTOR_JSON_URL = 'http://127.0.0.1:9229/json';

function fetchWsUrl() {
  return new Promise((resolve, reject) => {
    const req = http.get(INSPECTOR_JSON_URL, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body)[0].webSocketDebuggerUrl);
        } catch (e) {
          reject(new Error(`inspector /json unparseable: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('inspector /json timeout')));
  });
}

class Cdp {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const wsUrl = await fetchWsUrl();
    this.ws = new WebSocket(wsUrl);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    await this.send('Runtime.enable', {}, 5000);
    return this;
  }

  send(method, params, timeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalMain(expression, { timeout = 30000 } = {}) {
    const resp = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    }, timeout);
    const r = resp.result || {};
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      const desc = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text;
      throw new Error(`main-process eval failed: ${desc}`);
    }
    if (resp.error) throw new Error(`CDP error: ${resp.error.message}`);
    return r.result ? r.result.value : undefined;
  }

  // Runs `expression` inside the app's renderer (the localhost:8080
  // webContents). The expression may be/return a promise; the resolved value
  // must be JSON-serializable.
  async evalRenderer(expression, { timeout = 30000 } = {}) {
    const wrapped = `(() => {
      const { webContents } = require('electron');
      const wc = webContents.getAllWebContents()
        .find(w => w.getURL().includes('localhost:8080'));
      if (!wc) return Promise.resolve('__NO_RENDERER__');
      return wc.executeJavaScript(${JSON.stringify(expression)}, true);
    })()`;
    const value = await this.evalMain(wrapped, { timeout });
    if (value === '__NO_RENDERER__') {
      throw new Error('no renderer webContents on localhost:8080 — is the app window open?');
    }
    return value;
  }

  // Synthesizes a full left-button click at page CSS-pixel coordinates in the
  // app window. Goes through sendInputEvent, so real pointer events fire.
  async clickRenderer(x, y) {
    const expr = `(() => {
      const { webContents } = require('electron');
      const wc = webContents.getAllWebContents()
        .find(w => w.getURL().includes('localhost:8080'));
      if (!wc) return '__NO_RENDERER__';
      const base = { x: ${x}, y: ${y}, button: 'left', clickCount: 1 };
      wc.sendInputEvent({ type: 'mouseDown', ...base });
      wc.sendInputEvent({ type: 'mouseUp', ...base });
      return true;
    })()`;
    const value = await this.evalMain(expr, { timeout: 10000 });
    if (value === '__NO_RENDERER__') throw new Error('no renderer webContents for click');
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

module.exports = { Cdp };
