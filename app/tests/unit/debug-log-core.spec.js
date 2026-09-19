/* eslint-disable */
import {
  stripAnsi,
  createDebugLog,
  accelerationTransitionLines,
  DEBUG_LOG_MAX_ENTRIES,
  DEBUG_LOG_MAX_LINE_CHARS,
} from '@/util/debug-log-core';

// The Debug Log panel's pure core: ANSI stripping, chunk-to-line splitting
// with per-source carry, the bounded ring with monotonic seq, and the
// acceleration-transition differ. Everything time-related is injected.

describe('stripAnsi', () => {
  it('removes color codes from a tracing-formatted line', () => {
    // tracing_subscriber::fmt with ansi on: dimmed timestamp, colored level.
    const line = '\x1b[2m2026-09-18T04:12:33.001Z\x1b[0m \x1b[32m INFO\x1b[0m cadmium_sidecar: listening';
    expect(stripAnsi(line)).toBe('2026-09-18T04:12:33.001Z  INFO cadmium_sidecar: listening');
  });

  it('removes OSC sequences and lone escapes, leaves plain text alone', () => {
    expect(stripAnsi('\x1b]0;title\x07hello \x1b[1;31mred\x1b[0m')).toBe('hello red');
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });
});

describe('createDebugLog — appendChunk', () => {
  it('reassembles a line split across two chunks', () => {
    const log = createDebugLog({ nowFn: () => 5 });
    expect(log.appendChunk('sidecar', 'partial')).toEqual([]);
    const [entry] = log.appendChunk('sidecar', ' line\n');
    expect(entry).toEqual({ seq: 0, ts: 5, source: 'sidecar', line: 'partial line' });
  });

  it('splits on \\r\\n, \\n, and lone \\r', () => {
    const log = createDebugLog();
    const lines = log.appendChunk('sidecar', 'a\r\nb\nc\rd\n');
    expect(lines.map((e) => e.line)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps per-source carries independent', () => {
    const log = createDebugLog();
    log.appendChunk('sidecar', 'out-part');
    log.appendChunk('sidecar-err', 'err-part');
    expect(log.appendChunk('sidecar', 'A\n')[0].line).toBe('out-partA');
    expect(log.appendChunk('sidecar-err', 'B\n')[0].line).toBe('err-partB');
  });

  it('flushCarry emits trailing partials (one source or all)', () => {
    const log = createDebugLog();
    log.appendChunk('sidecar', 'tail-out');
    log.appendChunk('sidecar-err', 'tail-err');
    expect(log.flushCarry('sidecar').map((e) => e.line)).toEqual(['tail-out']);
    expect(log.flushCarry().map((e) => e.line)).toEqual(['tail-err']);
    expect(log.flushCarry()).toEqual([]); // nothing left
  });

  it('force-flushes a carry past the line cap, truncated', () => {
    const log = createDebugLog({ maxLineChars: 10 });
    const out = log.appendChunk('sidecar', 'x'.repeat(25)); // no newline at all
    expect(out.length).toBe(1);
    expect(out[0].line).toBe(`${'x'.repeat(10)}…`);
    // The carry was consumed — the next chunk starts fresh.
    expect(log.appendChunk('sidecar', 'y\n')[0].line).toBe('y');
  });

  it('strips the sidecar tracing line\'s own leading timestamp (ts is on the entry)', () => {
    const log = createDebugLog();
    const [entry] = log.appendChunk(
      'sidecar',
      '2026-09-19T02:42:23.710992Z  INFO cadmium_sidecar::serve::engine: still building\n',
    );
    expect(entry.line).toBe('INFO cadmium_sidecar::serve::engine: still building');
    // Lines without a leading timestamp are untouched.
    expect(log.append('app', 'state -> ready').line).toBe('state -> ready');
  });

  it('skips blank lines and strips trailing whitespace', () => {
    const log = createDebugLog();
    const lines = log.appendChunk('sidecar', 'a  \n\n   \nb\n');
    expect(lines.map((e) => e.line)).toEqual(['a', 'b']);
  });
});

describe('createDebugLog — ring and listeners', () => {
  it('caps the ring at maxEntries with seq still monotonic', () => {
    const log = createDebugLog({ maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) log.append('app', `line ${i}`);
    const entries = log.entries();
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(entries.map((e) => e.line)).toEqual(['line 2', 'line 3', 'line 4']);
  });

  it('defaults are exported and sane', () => {
    expect(DEBUG_LOG_MAX_ENTRIES).toBeGreaterThan(100);
    expect(DEBUG_LOG_MAX_LINE_CHARS).toBeGreaterThan(100);
  });

  it('onAppend fires per entry, unsubscribes, and swallows listener throws', () => {
    const log = createDebugLog();
    const seen = [];
    const unsubscribe = log.onAppend((e) => seen.push(e.line));
    log.onAppend(() => { throw new Error('broken listener'); });
    log.append('app', 'one'); // the throwing listener must not block this
    expect(seen).toEqual(['one']);
    unsubscribe();
    log.append('app', 'two');
    expect(seen).toEqual(['one']);
    expect(log.entries().length).toBe(2);
  });
});

describe('accelerationTransitionLines', () => {
  const status = (state, accel) => ({
    state,
    health: accel ? { acceleration: accel } : null,
  });

  it('produces nothing for identical consecutive snapshots (health-poll no-spam)', () => {
    const a = status('ready', { colorize: { planned: 'coreml', active: 'building', reason: null } });
    const b = status('ready', { colorize: { planned: 'coreml', active: 'building', reason: null } });
    expect(accelerationTransitionLines(a, b)).toEqual([]);
  });

  it('reports an active flip per capability', () => {
    const a = status('ready', {
      colorize: { planned: 'coreml', active: 'building', reason: null },
      segment: { planned: 'coreml', active: 'coreml', reason: null },
    });
    const b = status('ready', {
      colorize: { planned: 'coreml', active: 'coreml', reason: null },
      segment: { planned: 'coreml', active: 'coreml', reason: null },
    });
    expect(accelerationTransitionLines(a, b)).toEqual(['acceleration colorize: coreml']);
  });

  it('includes the reason and the planned/active divergence for a CPU fallback', () => {
    const a = status('ready', { colorize: { planned: 'coreml', active: 'building', reason: null } });
    const b = status('ready', {
      colorize: { planned: 'coreml', active: 'cpu', reason: 'CoreML compile failed' },
    });
    expect(accelerationTransitionLines(a, b)).toEqual([
      'acceleration colorize: cpu (planned coreml) — reason: CoreML compile failed',
    ]);
  });

  it('handles a null previous status (first report) and null health', () => {
    const b = status('ready', { colorize: { planned: 'coreml', active: 'building', reason: null } });
    expect(accelerationTransitionLines(null, b)).toEqual(['acceleration colorize: building']);
    // health gone (crash): nothing to diff against — no lines, no throw.
    expect(accelerationTransitionLines(b, status('starting', null))).toEqual([]);
  });
});
