#!/usr/bin/env node
/*
 * Cadmium e2e suite runner.
 *
 *   node tests/e2e/run.js [--only=<substr>] [--skip-ml] [--list] [--no-backup]
 *
 * Preconditions (the runner checks and explains, it does not start them):
 *   - app running via `npm run electron:serve` with the node inspector open
 *     on :9229 (`kill -USR1 <electron main pid>`)
 *   - for ML specs: the colorize server reachable on :8000 (wallace tunnel)
 *
 * The runner ALWAYS backs up the in-memory project to .artifacts/ before the
 * first reset — specs wipe the timeline.
 */
const fs = require('fs');
const path = require('path');
const { Driver } = require('./harness/driver');
const { generateFixtures } = require('./harness/fixtures');

const SPECS_DIR = path.join(__dirname, 'specs');
const ARTIFACTS = path.join(__dirname, '.artifacts');

function parseArgs(argv) {
  const args = { only: null, skipMl: false, list: false, backup: true };
  for (const a of argv) {
    if (a.startsWith('--only=')) args.only = a.slice(7);
    else if (a === '--skip-ml') args.skipMl = true;
    else if (a === '--list') args.list = true;
    else if (a === '--no-backup') args.backup = false;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

function loadSpecs() {
  return fs.readdirSync(SPECS_DIR)
    .filter((f) => /^\d\d-.*\.js$/.test(f)) // NN-name.js only — skips the stock Cypress scaffold
    .sort()
    .map((f) => {
      const spec = require(path.join(SPECS_DIR, f));
      if (!spec.name || typeof spec.run !== 'function') {
        throw new Error(`${f} must export { name, run } (and optionally ml: true)`);
      }
      return { file: f, ...spec };
    });
}

async function snapshotOnFailure(d, name) {
  try {
    const snap = await d.storeEval(`
      return {
        currentProcessingTask: s.state.currentProcessingTask,
        lineFrames: s.state.layers.lineLayer1.frames.filter(Boolean).length,
        colorFrames: s.state.layers.colorLayer1.frames.filter(Boolean).length,
        palette: s.state.colorPalette.length,
        referenceImages: s.state.referenceImages.length,
        selectedFrame: s.state.selectedFrame,
      };
    `);
    const file = path.join(ARTIFACTS, `failure-${name.replace(/[^a-z0-9-]/gi, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
    return file;
  } catch (e) {
    return `(snapshot failed: ${e.message})`;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specs = loadSpecs();

  if (args.list) {
    for (const s of specs) console.log(`${s.file}  ${s.ml ? '[ml] ' : ''}${s.name}`);
    return;
  }

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const fixtures = generateFixtures(path.join(ARTIFACTS, 'fixtures'));

  let d;
  try {
    d = await Driver.connect();
  } catch (e) {
    console.error(`Cannot reach the app inspector on :9229 (${e.message}).`);
    console.error('Start the app (`npm run electron:serve` with ELECTRON_RUN_AS_NODE unset),');
    console.error('then open the inspector: `kill -USR1 <electron main pid>`.');
    process.exit(2);
  }

  // Sanity: renderer + store reachable.
  await d.storeEval('return true;');
  d.stagingDir = path.join(ARTIFACTS, 'staging');

  // Preserve whatever project is open before the suite wipes it.
  if (args.backup) {
    const frames = await d.storeEval(
      'return s.state.layers.lineLayer1.frames.filter(Boolean).length'
      + ' + s.state.layers.colorLayer1.frames.filter(Boolean).length;',
    );
    if (frames > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(ARTIFACTS, `pre-suite-backup-${stamp}.cdm`);
      await d.saveProject(backupPath);
      console.log(`backed up open project (${frames} frames) → ${backupPath}`);
    }
  }

  const mlUp = args.skipMl ? false : await d.serverUp();
  if (!mlUp) console.log(args.skipMl ? 'ML specs skipped (--skip-ml)' : 'ML server :8000 unreachable — ML specs will be skipped');

  const results = [];
  for (const spec of specs) {
    if (args.only && !`${spec.file} ${spec.name}`.includes(args.only)) continue;
    if (spec.ml && !mlUp) {
      results.push({ spec, status: 'skip' });
      console.log(`SKIP  ${spec.name} (needs ML server)`);
      continue;
    }
    const t0 = Date.now();
    try {
      await d.resetProject();
      const ctx = { fixtures, artifactsDir: ARTIFACTS, mlUp };
      await spec.run(d, ctx);
      results.push({ spec, status: 'pass', ms: Date.now() - t0 });
      console.log(`PASS  ${spec.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      const snap = await snapshotOnFailure(d, spec.name);
      results.push({ spec, status: 'fail', ms: Date.now() - t0, err });
      console.log(`FAIL  ${spec.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      console.log(`      ${err.message.split('\n')[0]}`);
      console.log(`      state snapshot: ${snap}`);
    }
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  for (const r of results.filter((x) => x.status === 'fail')) {
    console.log(`\n--- ${r.spec.name} ---\n${r.err.stack}`);
  }

  d.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
