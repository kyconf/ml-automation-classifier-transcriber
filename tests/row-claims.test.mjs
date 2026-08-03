// Where a page's questions land, and where that leaves the fallback cursor.
//
// The cursor is what a question falls back to when its printed number is
// unusable. It used to advance by the number of entries a page returned, which
// counted entries that claimed no row at all because their row was already
// occupied. Duplicates are routine, so the cursor drifted a row further from the
// truth with each one; on 202603asiav1 it reached the math block while the pages
// being read were still Reading and Writing, and planPageWrite then discarded 24
// real questions as "Reading and Writing overrun".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeQuestions, createRowAssigner, FIRST_MATH_ROW } from '../lib/pipeline.js';

// A page of n questions, numbered as given. `values` is just a tag so the tests
// can prove the right row got the right question.
const page = (numbers, section = 'Reading and Writing') => ({
  rows: numbers.map((n) => `q${n}`),
  questions: numbers.map((n) => ({ question_number: n, section })),
});

const place = (numbers, { startRow, taken = new Map(), assign = createRowAssigner(), isMathPage = false, section } = {}) =>
  placeQuestions({ ...page(numbers, section), startRow, isMathPage, assignRow: assign, taken });

test('a page of new questions claims a row each and moves the cursor past them', () => {
  const out = place([1, 2, 3], { startRow: 2 });

  assert.deepEqual(out.claims.map((c) => c.row), [2, 3, 4]);
  assert.equal(out.nextCursor, 5);
});

test('a duplicate claims nothing and does not move the cursor', () => {
  // The exact shape of the bug: pages 6 and 7 both returned questions 17-19.
  const assign = createRowAssigner();
  const first = place([17, 18, 19], { startRow: 18, assign });
  const taken = new Map(first.claims.map((c) => [c.row, c.values]));

  const second = place([17, 18, 19], { startRow: first.nextCursor, assign, taken });

  assert.deepEqual(second.claims, [], 'nothing new was claimed');
  assert.equal(second.nextCursor, first.nextCursor, 'so the cursor must not move');
});

test('a page of nothing but duplicates leaves the cursor exactly where it was', () => {
  const taken = new Map([[5, 'q4'], [6, 'q5']]);
  const out = place([4, 5], { startRow: 5, taken });

  assert.equal(out.claims.length, 0);
  assert.equal(out.nextCursor, 5);
});

test('the cursor follows the printed number, not the number of entries', () => {
  // One duplicate among three real questions. Counting entries would return 8;
  // only rows 5, 6 and 7 were actually taken.
  const assign = createRowAssigner();
  assign(3, false); // question 3 already placed in row 4 by an earlier page
  const out = place([3, 4, 5, 6], { startRow: 5, taken: new Map([[4, 'q3']]), assign });

  assert.deepEqual(out.claims.map((c) => c.row), [5, 6, 7]);
  assert.equal(out.nextCursor, 8);
});

test('twenty pages of doubled questions cannot push the cursor into the math block', () => {
  // Every Reading and Writing page returned twice over, which is what the overlap
  // window produced. Reading and Writing must still stop at row 55.
  const assign = createRowAssigner();
  const taken = new Map();
  let cursor = 2;

  for (let n = 1; n <= 27; n += 1) {
    for (const _ of [0, 1]) { // the same question, read twice
      const out = place([n], { startRow: cursor, taken, assign });
      for (const claim of out.claims) taken.set(claim.row, claim.values);
      cursor = out.nextCursor;
    }
  }

  assert.equal(taken.size, 27, 'one row per question, not two');
  assert.ok(cursor < FIRST_MATH_ROW, `cursor reached row ${cursor}; math starts at ${FIRST_MATH_ROW}`);
});

// REVERSED. This used to assert that a question with no printed number fell back
// to its position on the page. That fallback is what put the mofongo question
// into question 5's row and pushed question 5 off the sheet — the cursor is a
// guess from page position with no relationship to the printed numbering.
//
// The rule now is that order beats coverage: one question in the wrong row
// misaligns everything read against it, where a gap is merely a gap. Measured
// across three exams this drops at most four entries, every one of which was
// being guessed into a row regardless.
test('a question with no usable number is left out rather than guessed at', () => {
  const out = place([null, null], { startRow: 40 });

  assert.deepEqual(out.claims, [], 'nothing is placed on a guess');
  assert.equal(out.nextCursor, 40, 'and the cursor does not move');
  assert.equal(out.notes.filter((n) => n.includes('No usable question number')).length, 2);
});

test('a numbered question on the same page is unaffected by one that is not', () => {
  const out = place([null, 7, null], { startRow: 40 });

  assert.deepEqual(out.claims.map((c) => c.row), [8], 'only question 7 lands, in its own row');
});

test('a question placed by its printed number carries the cursor with it', () => {
  // Question 20 arriving while the cursor sits at 5 means rows up to 21 are spoken
  // for; leaving the cursor at 6 would hand row 6 to the next unnumbered question
  // and overwrite nothing, but would also let it drift behind reality.
  const out = place([20], { startRow: 5 });

  assert.deepEqual(out.claims.map((c) => c.row), [21]);
  assert.equal(out.nextCursor, 22);
});

test('the notes name every reroute and every skip', () => {
  const assign = createRowAssigner();
  const out = place([9, 9], { startRow: 5, assign });

  assert.equal(out.claims.length, 1);
  assert.equal(out.notes.filter((n) => n.includes('belongs in row')).length, 2);
  assert.equal(out.notes.filter((n) => n.includes('already holds a question')).length, 1);
});

test('the rows already taken are read, never written', () => {
  const taken = new Map([[2, 'existing']]);
  const out = place([1, 2], { startRow: 2 , taken });

  assert.deepEqual([...taken.keys()], [2], 'placeQuestions must not mutate the caller\'s map');
  assert.deepEqual(out.claims.map((c) => c.row), [3]);
});

test('math questions claim rows in the math block', () => {
  const out = place([1, 2], { startRow: FIRST_MATH_ROW, isMathPage: true, section: 'Math' });

  assert.deepEqual(out.claims.map((c) => c.row), [FIRST_MATH_ROW, FIRST_MATH_ROW + 1]);
  assert.equal(out.nextCursor, FIRST_MATH_ROW + 2);
});
