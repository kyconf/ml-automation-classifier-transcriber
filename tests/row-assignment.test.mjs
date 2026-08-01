// Questions go to the row their printed number names, not to the next free one.
// Counting rows meant a single dropped question shifted everything after it: when
// the first math question was discarded, all 43 that followed landed one row
// early and stopped matching their pre-filled module and number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRowAssigner,
  RW_PER_MODULE,
  MATH_PER_MODULE,
  FIRST_MATH_ROW,
  LAST_QUESTION_ROW,
} from '../lib/pipeline.js';

test('each module fills its own block of rows', () => {
  const assign = createRowAssigner();
  const rows = [];

  for (let n = 1; n <= RW_PER_MODULE; n += 1) rows.push(assign(n, false)); // module 1
  for (let n = 1; n <= RW_PER_MODULE; n += 1) rows.push(assign(n, false)); // module 2
  for (let n = 1; n <= MATH_PER_MODULE; n += 1) rows.push(assign(n, true));
  for (let n = 1; n <= MATH_PER_MODULE; n += 1) rows.push(assign(n, true));

  assert.deepEqual([rows[0], rows.at(-1)], [2, LAST_QUESTION_ROW]);
  assert.equal(rows.length, 98);
  assert.equal(new Set(rows).size, 98, 'every question gets its own row');
  assert.deepEqual(rows, [...rows].sort((a, b) => a - b), 'rows run in order');
});

test('a module boundary is detected by the number restarting', () => {
  const assign = createRowAssigner();
  for (let n = 1; n <= 27; n += 1) assign(n, false);   // module 1 in full
  assert.equal(assign(1, false), 29, 'restarting after a full module means module 2');
  assert.equal(assign(2, false), 30);
});

test('a stray out-of-order number does not start a new module', () => {
  // From a real run: one low number arriving out of order early in module 1
  // bumped the counter, and questions 5-19 landed in module 2's rows while
  // module 1's stayed empty. Fourteen questions were then dropped as overrun.
  const assign = createRowAssigner();
  const rows = [1, 2, 3, 4, 2, 5, 6, 7].map((n) => assign(n, false));

  assert.deepEqual(rows, [2, 3, 4, 5, 3, 6, 7, 8]);
  assert.ok(rows.every((r) => r <= 28), 'nothing escaped into module 2');
});

test('a restart is only believed once most of a module has been seen', () => {
  const assign = createRowAssigner();
  assign(1, false);
  assert.equal(assign(1, false), 2, 'question 1 twice at the start is a duplicate');

  const later = createRowAssigner();
  for (let n = 1; n <= 20; n += 1) later(n, false);
  assert.equal(later(1, false), 29, 'question 1 after twenty questions is module 2');
});

test('math and reading and writing count modules independently', () => {
  const assign = createRowAssigner();
  assert.equal(assign(1, false), 2);
  assert.equal(assign(1, true), FIRST_MATH_ROW, 'math starting does not advance the RW module');
  assert.equal(assign(2, false), 3, 'RW carries on where it left off');
});

test('a dropped question leaves a gap instead of shifting the rest', () => {
  // The exact failure: math question 1 never arrived.
  const assign = createRowAssigner();
  const rows = [];
  for (let n = 2; n <= 12; n += 1) rows.push(assign(n, true)); // 1 is missing

  assert.equal(rows[0], 57, 'question 2 still belongs in row 57');
  assert.equal(rows.at(-1), 67, 'question 12 still belongs in row 67');
  assert.ok(!rows.includes(FIRST_MATH_ROW), 'row 56 is left empty for the missing question');
});

test('an unusable number falls back to the caller', () => {
  const assign = createRowAssigner();
  for (const bad of [null, undefined, 0, -3, 'seven', 1.5]) {
    assert.equal(assign(bad, false), null, `${bad} should not produce a row`);
  }
});

test('a number beyond the module size is refused', () => {
  const assign = createRowAssigner();
  assert.equal(assign(28, false), null, 'Reading and Writing modules hold 27');
  assert.equal(assign(23, true), null, 'math modules hold 22');
});

test('a third module is refused rather than overflowing the sheet', () => {
  // Each restart must look real: a full module, then a return to question 1.
  const assign = createRowAssigner();
  for (let n = 1; n <= 22; n += 1) assign(n, true);   // module 1
  for (let n = 1; n <= 22; n += 1) assign(n, true);   // module 2
  assert.equal(assign(1, true), null, 'there is no third math module');
});

test('a repeated question number stays in its own module', () => {
  // A duplicate used to read as a module boundary, which threw every question
  // after it into the wrong block.
  const assign = createRowAssigner();
  assert.equal(assign(5, false), 6);
  assert.equal(assign(5, false), 6, 'the duplicate maps to the same row, to be skipped');
  assert.equal(assign(6, false), 7, 'and the next question is unaffected');
});

test('no assigned row can fall outside the template', () => {
  const assign = createRowAssigner();
  const rows = [];
  for (const isMath of [false, true]) {
    const perModule = isMath ? MATH_PER_MODULE : RW_PER_MODULE;
    for (let module = 0; module < 2; module += 1) {
      for (let n = 1; n <= perModule; n += 1) {
        const row = assign(n, isMath);
        if (row !== null) rows.push(row);
      }
    }
  }
  assert.ok(Math.min(...rows) >= 2);
  assert.ok(Math.max(...rows) <= LAST_QUESTION_ROW);
});
