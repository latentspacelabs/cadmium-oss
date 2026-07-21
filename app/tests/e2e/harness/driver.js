/*
 * App-level driver for Cadmium e2e tests.
 *
 * Wraps the CDP client with store access (`s` = $store, `g` = getters inside
 * every `storeEval` body), dialog-free action entry points, and the polling
 * primitives the specs are built from.
 *
 * DIALOG RULE: @electron/remote is bundled into the app, so native dialogs
 * CANNOT be stubbed from outside — any code path that reaches showCustomDialog
 * / showSaveDialog opens a real macOS sheet and blocks the store forever.
 * Specs must stay on dialog-free paths (filePath overrides, unsavedChanges
 * cleared before NEW_PROJECT, valid import queues).
 */
const fs = require('fs');
const path = require('path');
const { Cdp } = require('./cdp');

const LINE_LAYER = 'lineLayer1';
const COLOR_LAYER = 'colorLayer1';

class Driver {
  constructor(cdp) {
    this.cdp = cdp;
  }

  static async connect() {
    const cdp = await new Cdp().connect();
    // The app window is usually occluded while tests run; Chromium then
    // throttles rAF/timers, which freezes Vue <transition> leave animations —
    // overlays get stuck mid-fade and swallow clicks. Disable throttling.
    await cdp.evalMain(`(() => {
      const { webContents } = require('electron');
      const wc = webContents.getAllWebContents().find(w => w.getURL().includes('localhost:8080'));
      if (wc) wc.setBackgroundThrottling(false);
      return true;
    })()`);
    return new Driver(cdp);
  }

  close() {
    this.cdp.close();
  }

  // ---- core eval -----------------------------------------------------------

  // Run `fnBody` in the renderer with `s` ($store) and `g` (getters) in scope.
  // The body may use await; whatever it returns must be JSON-serializable.
  storeEval(fnBody, opts = {}) {
    const expr = `(async () => {
      const s = document.getElementById('app').__vue__.$store;
      const g = s.getters;
      ${fnBody}
    })()`;
    return this.cdp.evalRenderer(expr, opts);
  }

  commit(type, payload) {
    const args = payload === undefined
      ? JSON.stringify(type)
      : `${JSON.stringify(type)}, ${JSON.stringify(payload)}`;
    return this.storeEval(`s.commit(${args}); return true;`);
  }

  // fire=true kicks the dispatch off and returns immediately — REQUIRED for
  // anything long-running (import/colorize/export); poll with waitUntil/idle
  // afterwards. Awaiting a dispatch that hits a native dialog never returns.
  dispatch(type, payload, { fire = false, timeout = 120000 } = {}) {
    const args = payload === undefined
      ? JSON.stringify(type)
      : `${JSON.stringify(type)}, ${JSON.stringify(payload)}`;
    const body = fire
      ? `void s.dispatch(${args}); return true;`
      : `await s.dispatch(${args}); return true;`;
    return this.storeEval(body, { timeout });
  }

  // ---- polling -------------------------------------------------------------

  async waitUntil(fnBody, { timeout = 30000, interval = 300, desc = fnBody } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      last = await this.storeEval(fnBody);
      if (last) return last;
      if (Date.now() > deadline) {
        throw new Error(`waitUntil timed out (${timeout}ms): ${desc} — last value: ${JSON.stringify(last)}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // Waits for the JobRunner to be idle (no import/colorize/export running).
  idle({ timeout = 300000 } = {}) {
    return this.waitUntil(
      "return s.state.currentProcessingTask === 'TASK_NONE';",
      { timeout, desc: 'JobRunner idle (currentProcessingTask === TASK_NONE)' },
    );
  }

  // ---- state readers -------------------------------------------------------

  // Non-null frames of a layer, with the fields specs assert on.
  frames(layerId = LINE_LAYER) {
    return this.storeEval(`
      return s.state.layers[${JSON.stringify(layerId)}].frames
        .filter(Boolean)
        .map(f => ({
          frameNr: f.frameNr,
          imageDataId: f.imageDataId || null,
          isOriginal: !!f.isOriginal,
          isSelected: !!f.isSelected,
          isLoading: !!f.isLoading,
        }));
    `);
  }

  palette() {
    return this.storeEval('return s.state.colorPalette;');
  }

  imageRecord(imageDataId) {
    return this.storeEval(`
      const r = s.state.ImageStore.imageDataById[${JSON.stringify(imageDataId)}];
      if (!r) return null;
      return { hash: r.hash || null, hasBytes: !!r.dataUri, uriLength: r.dataUri ? r.dataUri.length : 0 };
    `);
  }

  // Decodes an ImageStore record's dataUri and samples one pixel → [r,g,b,a].
  async pixelFromRecord(imageDataId, x, y) {
    return this.storeEval(`
      const rec = s.state.ImageStore.imageDataById[${JSON.stringify(imageDataId)}];
      if (!rec || !rec.dataUri) return null;
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = rec.dataUri; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(${x}, ${y}, 1, 1).data);
    `, { timeout: 15000 });
  }

  // ---- dialogs -------------------------------------------------------------

  // The app's error/info dialogs are the in-page CustomDialog component
  // (NOT native), so we can see and dismiss them. Returns {title, message}
  // or null.
  openDialog() {
    return this.storeEval(`
      const el = document.querySelector('.custom-dialog');
      if (!el) return null;
      return {
        title: (el.querySelector('.custom-dialog__title') || {}).textContent || '',
        message: (el.querySelector('.custom-dialog__message') || {}).textContent || '',
      };
    `);
  }

  async dismissDialog() {
    return this.storeEval(`
      const btn = document.querySelector('.custom-dialog__button--primary')
        || document.querySelector('.custom-dialog__button');
      if (!btn) return false;
      btn.click();
      return true;
    `);
  }

  // ---- lifecycle -----------------------------------------------------------

  // Dialog-free New Project: clears unsavedChanges first so ASK_TO_SAVE never
  // raises the native save sheet, and deselects both layers so nothing leaks
  // into the next spec's selection-sensitive actions.
  async resetProject() {
    // Clear any dialog a previous spec left behind (they stack-suppress, but
    // one can linger and would swallow the next spec's dialog).
    for (let i = 0; i < 3; i += 1) {
      const dlg = await this.openDialog();
      if (!dlg) break;
      console.warn(`resetProject: dismissing leftover dialog "${dlg.title}"`);
      await this.dismissDialog();
      await new Promise((r) => setTimeout(r, 200));
    }
    // Sweep any transition overlay stuck in its leave phase (see clickElement).
    await this.storeEval(`
      document.querySelectorAll('[class*="-leave"]').forEach(el => el.remove());
      return true;
    `);
    await this.idle({ timeout: 10000 }).catch(() => {
      throw new Error('resetProject: a job is still running — refusing to reset under it');
    });
    await this.commit('set_frames_selected_on_whole_layer', { layerId: LINE_LAYER, isSelected: false });
    await this.commit('set_frames_selected_on_whole_layer', { layerId: COLOR_LAYER, isSelected: false });
    await this.commit('set_unsaved_changes', false);
    await this.dispatch('new_project', undefined, { timeout: 30000 });
    const frames = await this.frames(LINE_LAYER);
    if (frames.length !== 0) throw new Error(`resetProject left ${frames.length} line frames`);
  }

  saveProject(absPath) {
    return this.dispatch('create_saved_file', { saveFilePath: absPath }, { timeout: 120000 });
  }

  async loadProject(absPath) {
    await this.dispatch('load_file', { filePath: absPath }, { timeout: 60000 });
    // LOAD_FILE resolves before its internal promise chain settles; wait for
    // frames to materialize.
    await this.waitUntil(
      `return s.state.layers.${LINE_LAYER}.frames.some(Boolean)
           || s.state.layers.${COLOR_LAYER}.frames.some(Boolean);`,
      { timeout: 30000, desc: 'loaded .cdm frames present' },
    );
  }

  // ---- imports -------------------------------------------------------------

  // Imports absolute PNG paths onto a layer via ADD_IMAGES_TO_TIMELINE.
  //
  // The importer places each file at the frame number embedded in its
  // FILENAME (trailing digits, required, and +1'd by the importer — the
  // documented QUIRK: file _000 lands on frame 1), so the paths are staged
  // as numbered copies first: position i → e2e_00(i).png. Byte-identical sources stay
  // byte-identical after staging, so dupe detection still sees them as one
  // drawing. Real File objects are built in the renderer (node integration
  // is on).
  async importImages(absPaths, layerId = LINE_LAYER) {
    const staging = this.stagingDir || path.join(require('os').tmpdir(), 'cadmium-e2e-staging');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const staged = absPaths.map((src, i) => {
      if (!fs.existsSync(src)) throw new Error(`importImages: missing fixture ${src}`);
      const dst = path.join(staging, `e2e_${String(i).padStart(3, '0')}.png`);
      fs.copyFileSync(src, dst);
      return dst;
    });

    const before = (await this.frames(layerId)).length;
    await this.storeEval(`
      const fs = require('fs');
      const path = require('path');
      const paths = ${JSON.stringify(staged)};
      const files = paths.map(p => new File(
        [new Uint8Array(fs.readFileSync(p))],
        path.basename(p),
        { type: 'image/png' },
      ));
      void s.dispatch('add_images_to_timeline', {
        layerId: ${JSON.stringify(layerId)},
        fileLoadingQueue: files,
      });
      return true;
    `);

    // Poll for completion, but fail fast (with the dialog title) if the
    // importer raised an error dialog instead of importing.
    const deadline = Date.now() + 60000;
    for (;;) {
      const n = await this.storeEval(
        `return s.state.layers[${JSON.stringify(layerId)}].frames.filter(Boolean).length;`,
      );
      if (n >= before + absPaths.length) break;
      const dlg = await this.openDialog();
      if (dlg) {
        await this.dismissDialog();
        throw new Error(`import raised a dialog: "${dlg.title}" — ${dlg.message}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`import of ${absPaths.length} images onto ${layerId} timed out (have ${n}, want ${before + absPaths.length})`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    await this.idle({ timeout: 120000 });
  }

  // Adds a reference image to the reference panel (LOAD_REFERENCE_FILE takes
  // ONE file despite the parameter name).
  async loadReference(absPath) {
    const before = await this.storeEval('return s.state.referenceImages.length;');
    await this.storeEval(`
      const fs = require('fs');
      const path = require('path');
      const file = new File(
        [new Uint8Array(fs.readFileSync(${JSON.stringify(absPath)}))],
        path.basename(${JSON.stringify(absPath)}),
        { type: 'image/png' },
      );
      await s.dispatch('load_reference_file', { fileLoadingQueue: file });
      return true;
    `, { timeout: 30000 });
    await this.waitUntil(
      `return s.state.referenceImages.length > ${before};`,
      { timeout: 10000, desc: 'reference image added' },
    );
  }

  // Writes a PNG onto a COLOR frame through the same store sequence the paint
  // bucket uses (store image → set frame data as original → correct
  // originality). Lets non-ML specs build colored state without the
  // server-backed fill.
  async setColorFrame(frameNr, absPngPath) {
    return this.storeEval(`
      const fs = require('fs');
      const dataUri = 'data:image/png;base64,' + fs.readFileSync(${JSON.stringify(absPngPath)}).toString('base64');
      const imageDataId = await s.dispatch('store_image_data_in_image_store', { dataUri, forceNew: false });
      s.commit('set_image_data_for_frame_with_id', {
        layerId: ${JSON.stringify(COLOR_LAYER)},
        imageDataId,
        frameNr: ${frameNr},
        isOriginal: true,
        force: true,
      });
      await s.dispatch('correct_originality_of_frames_on_layer', { layerId: ${JSON.stringify(COLOR_LAYER)} });
      return imageDataId;
    `, { timeout: 20000 });
  }

  // Appends a full swatch object (the shape POPULATE_PALETTE produces).
  addPaletteColor(hex) {
    return this.commit('add_color_to_palette', {
      hex,
      newHex: hex,
      visible: true,
      newVisible: true,
      selected: false,
      firstSelected: false,
      opacity: 255,
      newOpacity: 255,
    });
  }

  // ---- tools & canvas ------------------------------------------------------

  // ACTIVATE_TOOL_BY_ID is a TOGGLE (sidebar-button semantics): dispatching
  // it while the tool's panel is already visible hides it again — which made
  // alternate test rounds silently deactivate the tool. preventClose makes
  // activation idempotent.
  activateTool(toolId) {
    return this.dispatch('activate_tool_by_id', { toolId, preventClose: true }, { timeout: 10000 });
  }

  // Clicks a page element at a fractional position (fx, fy ∈ [0,1]) of its
  // bounding rect, through real synthesized mouse events.
  //
  // Dialog-proof: the app raises overlay dialogs on its own schedule (e.g.
  // "No Internet Connection" when the ML server is down), and an overlay
  // swallows synthesized clicks silently. So before clicking we dismiss any
  // open dialog and verify via elementFromPoint that the click will actually
  // land inside the target.
  async clickElement(selector, fx, fy) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dlg = await this.openDialog();
      if (dlg) {
        console.warn(`clickElement: dismissing overlay dialog "${dlg.title}"`);
        await this.dismissDialog();
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const pt = await this.storeEval(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'no element matches' };
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { error: 'zero size' };
        const x = Math.round(r.left + r.width * ${fx});
        const y = Math.round(r.top + r.height * ${fy});
        let hit = document.elementFromPoint(x, y);
        // A Vue transition stuck in its leave phase (throttled window) leaves
        // a dead overlay in the DOM — remove it rather than waiting forever.
        if (hit && /-leave/.test(hit.className || '')) {
          const stuck = (hit.className || '').toString();
          hit.remove();
          hit = document.elementFromPoint(x, y);
          if (hit && (el === hit || el.contains(hit))) {
            return { x, y, covered: false, removedOverlay: stuck };
          }
        }
        return { x, y, covered: !(hit && (el === hit || el.contains(hit) || hit.contains(el))) };
      `);
      if (pt.error) throw new Error(`clickElement ${selector}: ${pt.error}`);
      if (pt.removedOverlay) console.warn(`clickElement: removed stuck overlay "${pt.removedOverlay}"`);
      if (pt.covered) {
        await new Promise((r) => setTimeout(r, 300));
        continue; // something transient is on top; re-check (maybe a dialog just opened)
      }
      await this.cdp.clickRenderer(pt.x, pt.y);
      return pt;
    }
    throw new Error(`clickElement ${selector}: target stayed covered by an overlay after 3 attempts`);
  }

  // Clicks until `predicate` (a storeEval body) turns truthy — the cure for
  // click races: an overlay can appear between the hit-test and the
  // synthesized event and swallow the click silently, so a single click is
  // never trusted. Returns the predicate's value.
  async clickElementUntil(selector, fx, fy, predicate, { attempts = 4, settleMs = 2500 } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
      await this.clickElement(selector, fx, fy);
      try {
        return await this.waitUntil(predicate, { timeout: settleMs, desc: `click effect: ${predicate.slice(0, 80)}` });
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`clickElementUntil ${selector}: no effect after ${attempts} clicks — ${lastErr.message}`);
  }

  // ---- environment ---------------------------------------------------------

  // True when the ML server answers on the configured URL (default :8000).
  async serverUp() {
    return this.cdp.evalMain(`(() => new Promise((resolve) => {
      const http = require('http');
      const req = http.get('http://localhost:8000/', () => { resolve(true); req.destroy(); });
      req.on('error', () => resolve(false));
      req.setTimeout(2500, () => { req.destroy(); resolve(false); });
    }))()`, { timeout: 8000 });
  }
}

module.exports = { Driver, LINE_LAYER, COLOR_LAYER };
