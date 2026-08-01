// Pages are transcribed several at a time but written strictly in page order,
// because every row depends on how many rows were handed out before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency, reportRunHealth } from '../lib/pipeline.js';

test('results come back in input order however they finish', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 5, async (x) => {
    await new Promise((r) => setTimeout(r, Math.random() * 15));
    return x * 2;
  });
  assert.deepEqual(out, items.map((x) => x * 2));
});

test('never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array(20).fill(0), 5, async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
  });
  assert.ok(peak <= 5, `peak was ${peak}`);
  assert.ok(peak >= 4, `never actually ran in parallel, peak was ${peak}`);
});

test('is genuinely faster than running in series', async () => {
  const started = Date.now();
  await mapWithConcurrency(Array(20).fill(0), 5, () => new Promise((r) => setTimeout(r, 25)));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `took ${elapsed}ms, serial would be ~500ms`);
});

test('handles an empty list and a limit larger than the list', async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 5, async (x) => x), [1, 2]);
});

// Run health only reports. It must never be able to change what was written.
function capture(fn) {
  const lines = [];
  const { log, warn } = console;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = log; console.warn = warn; }
  return lines.join('\n');
}

const page = (name, n) => ({ image: '/x/' + name, questions: Array(n).fill({}) });
const written = (name, n) => ({ image: '/x/' + name, response: Array(n).fill({}) });

test('a complete run reports nothing amiss', () => {
  const out = capture(() => reportRunHealth(
    Array.from({ length: 49 }, (_, i) => page(`page-${i + 1}.png`, 2)),
    Array.from({ length: 49 }, (_, i) => written(`page-${i + 1}.png`, 2)),
    { questionsPerPage: 2, totalQuestions: 98, pageCount: 49 },
    'exam',
  ));
  assert.match(out, /nothing looks off/);
  assert.match(out, /98 question/);
});

test('a short run is called out with the offending pages', () => {
  const out = capture(() => reportRunHealth(
    [page('page-01.png', 2), page('page-02.png', 1)],
    [written('page-01.png', 2), written('page-02.png', 1)],
    { questionsPerPage: 2, totalQuestions: 98, pageCount: 49 },
    'exam',
  ));
  assert.match(out, /but wrote 3/);
  assert.match(out, /page-02\.png:1/);
});

test('failed and skipped pages are both surfaced', () => {
  const out = capture(() => reportRunHealth(
    [page('page-01.png', 2)],
    [{ image: '/x/page-01.png', error: 'boom' }, { image: '/x/page-09.png', skipped: 'past row 99' }],
    { questionsPerPage: 2, totalQuestions: 98, pageCount: 49 },
    'exam',
  ));
  assert.match(out, /failed: page-01\.png/);
  assert.match(out, /skipped/);
});

test('missing structure information is not treated as a problem', () => {
  assert.match(
    capture(() => reportRunHealth([page('p.png', 2)], [written('p.png', 2)], null, 'exam')),
    /nothing looks off/,
  );
  assert.match(
    capture(() => reportRunHealth([page('p.png', 3)], [written('p.png', 3)],
      { questionsPerPage: null, totalQuestions: null, pageCount: 1 }, 'exam')),
    /nothing looks off/,
  );
});

test('writing more than expected is not an error', () => {
  // The structure pass estimates; only a short run is suspicious.
  assert.match(
    capture(() => reportRunHealth([page('p.png', 2)], [written('p.png', 2)],
      { questionsPerPage: 2, totalQuestions: 1, pageCount: 1 }, 'exam')),
    /nothing looks off/,
  );
});
