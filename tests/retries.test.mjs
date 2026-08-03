// Going back for a question the first pass missed.
//
// A gap is bracketed: the page that held the question before it and the page that
// held the one after it are both known, so the missing question is on one of
// them. That is enough to re-ask for it by name, which is a far narrower request
// than "transcribe this page" — the request that already failed.
//
// The rows below are the ones 202603asiav1 actually lost, with the pages its
// neighbours came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRetries, MAX_RETRIES, EXAM_SCOPE, FIRST_MATH_ROW, LAST_QUESTION_ROW } from '../lib/pipeline.js';

const allRows = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
// Every row filled, one page per row, so a gap can always be bracketed.
const everyRowOnItsOwnPage = () => new Map(allRows(2, LAST_QUESTION_ROW).map((r) => [r, r - 1]));

const planFor = (missing, extra = {}) => planRetries({
  filledRows: allRows(2, LAST_QUESTION_ROW).filter((r) => !missing.includes(r)),
  rowToPage: everyRowOnItsOwnPage(),
  ...extra,
});

test('a gap is bracketed by the pages either side of it', () => {
  const { retries } = planFor([17]);

  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0].pages, [15, 17], 'the pages that held rows 16 and 18');
  assert.equal(retries[0].row, 17);
});

test('the retry knows which question to ask for', () => {
  const { retries } = planFor([17, 70]);

  assert.deepEqual(
    retries.map((r) => [r.row, r.number, r.isMath]),
    [[17, 16, false], [70, 15, true]],
    'row 17 is Reading and Writing q16; row 70 is Math q15',
  );
});

test('a gap whose neighbours came from one page only re-reads that page', () => {
  const rowToPage = new Map([[83, 22], [85, 22]]);
  const { retries } = planRetries({
    filledRows: allRows(2, LAST_QUESTION_ROW).filter((r) => r !== 84),
    rowToPage,
  });

  assert.deepEqual(retries[0].pages, [22], 'not [22, 22]');
});

test('a full run asks for nothing', () => {
  const { retries, notes } = planRetries({
    filledRows: allRows(2, LAST_QUESTION_ROW),
    rowToPage: everyRowOnItsOwnPage(),
  });

  assert.deepEqual(retries, []);
  assert.deepEqual(notes, []);
});

test('a gap with no known neighbour is left alone', () => {
  // Nothing on either side means nothing to bracket against — re-reading a page
  // chosen by guesswork is the behaviour we just removed everywhere else.
  const { retries } = planRetries({
    filledRows: allRows(2, LAST_QUESTION_ROW).filter((r) => ![40, 41, 42].includes(r)),
    rowToPage: new Map(), // no page is known for any row
  });

  assert.deepEqual(retries, []);
});

test('a run that lost most of its questions is not retried at all', () => {
  // The 0% runs: something is wrong with the run, not with eighty pages. Re-asking
  // each of them costs real money and fixes nothing.
  const { retries, notes } = planRetries({
    filledRows: [],
    rowToPage: everyRowOnItsOwnPage(),
  });

  assert.deepEqual(retries, []);
  assert.match(notes.join(' '), /too many to be individual misses/);
});

test('the cap is the line between a miss and a broken run', () => {
  const justUnder = planFor(allRows(10, 10 + MAX_RETRIES - 1));
  const justOver = planFor(allRows(10, 10 + MAX_RETRIES));

  assert.equal(justUnder.retries.length, MAX_RETRIES);
  assert.equal(justOver.retries.length, 0);
});

test('a math only run does not try to fetch the Reading and Writing rows', () => {
  const { retries } = planRetries({
    filledRows: allRows(FIRST_MATH_ROW, LAST_QUESTION_ROW).filter((r) => r !== 60),
    rowToPage: everyRowOnItsOwnPage(),
    scope: EXAM_SCOPE.MATH,
  });

  assert.equal(retries.length, 1);
  assert.equal(retries[0].row, 60);
});

test('every retry names a page, a row and a question', () => {
  const { retries, notes } = planFor([17, 21, 70, 84]);

  assert.equal(retries.length, 4);
  for (const r of retries) {
    assert.ok(Number.isInteger(r.row) && Number.isInteger(r.number));
    assert.ok(r.pages.length && r.pages.every(Number.isInteger));
  }
  assert.equal(notes.filter((n) => n.startsWith('🔁')).length, 4);
});
