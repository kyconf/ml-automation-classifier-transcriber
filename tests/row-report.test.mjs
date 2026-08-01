// The end-of-run report. Every problem it shows was already in the live log, but
// buried in hundreds of lines of raw model output — this is the block at the
// bottom that says which rows to go and look at, and what is wrong with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRow, formatRowReport, EXAM_SCOPE, FIRST_MATH_ROW, LAST_QUESTION_ROW } from '../lib/pipeline.js';

const allRows = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
const report = (opts) => formatRowReport({ sheetName: 'exam', ...opts }).join('\n');

test('a row names the question slot it belongs to', () => {
  assert.deepEqual(describeRow(2), { section: 'Reading and Writing', module: 1, number: 1 });
  assert.deepEqual(describeRow(28), { section: 'Reading and Writing', module: 1, number: 27 });
  assert.deepEqual(describeRow(29), { section: 'Reading and Writing', module: 2, number: 1 });
  assert.deepEqual(describeRow(55), { section: 'Reading and Writing', module: 2, number: 27 });
  assert.deepEqual(describeRow(FIRST_MATH_ROW), { section: 'Math', module: 1, number: 1 });
  assert.deepEqual(describeRow(77), { section: 'Math', module: 1, number: 22 });
  assert.deepEqual(describeRow(78), { section: 'Math', module: 2, number: 1 });
  assert.deepEqual(describeRow(LAST_QUESTION_ROW), { section: 'Math', module: 2, number: 22 });
});

test('a row outside the template names nothing', () => {
  for (const bad of [1, 0, -4, 100, null, 'seven', 2.5]) {
    assert.equal(describeRow(bad), null, `${bad} is not a question row`);
  }
});

test('a clean run says so in one line', () => {
  const lines = formatRowReport({
    sheetName: 'exam',
    issues: [],
    filledRows: allRows(2, LAST_QUESTION_ROW),
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^✅ "exam": all 98 row\(s\) written, none flagged\.$/);
});

test('a flagged row shows its slot, the problem, and the question', () => {
  const out = report({
    issues: [{
      row: 30,
      detail: 'only 3 of 4 choices — missing D',
      question: 'Which choice completes the text with the most logical transition?\n\nA) Likewise,\nB) Next,\nC) In reality,',
    }],
    filledRows: allRows(2, LAST_QUESTION_ROW),
  });

  assert.match(out, /row 30\s+Reading and Writing module 2, question 2/);
  assert.match(out, /only 3 of 4 choices — missing D/);
  assert.match(out, /Which choice completes the text with the most logical transition\?/);
});

test('an empty row is reported even though it has no question to show', () => {
  const filled = allRows(2, LAST_QUESTION_ROW).filter((r) => r !== 67 && r !== 70);
  const out = report({ issues: [], filledRows: filled });

  assert.match(out, /2 row\(s\) empty/);
  assert.match(out, /row 67\s+Math module 1, question 12/);
  assert.match(out, /row 70\s+Math module 1, question 15/);
});

test('a long question is cut to one line', () => {
  const out = report({
    issues: [{ row: 2, detail: 'x', question: 'A'.repeat(400) }],
    filledRows: allRows(2, LAST_QUESTION_ROW),
  });

  const questionLine = out.split('\n').find((l) => l.includes('AAAA'));
  assert.ok(questionLine.length < 100, `line was ${questionLine.length} chars`);
  assert.match(questionLine, /…$/);
});

test('newlines in a question do not break the layout', () => {
  const out = report({
    issues: [{ row: 2, detail: 'x', question: 'Line one\n\nA) one\nB) two' }],
    filledRows: allRows(2, LAST_QUESTION_ROW),
  });

  assert.ok(!out.includes('A) one\nB) two'), 'the question must be flattened to one line');
  assert.match(out, /Line one A\) one B\) two/);
});

test('an entry with no question text at all still reports its row', () => {
  const out = report({
    issues: [{ row: 5, detail: 'no question text was parsed out of this entry', question: '' }],
    filledRows: allRows(2, LAST_QUESTION_ROW),
  });

  assert.match(out, /row 5/);
  assert.match(out, /\(no question text\)/);
});

test('flagged rows are listed in row order however they arrived', () => {
  const out = report({
    issues: [
      { row: 40, detail: 'c', question: 'q40' },
      { row: 3, detail: 'a', question: 'q3' },
      { row: 12, detail: 'b', question: 'q12' },
    ],
    filledRows: allRows(2, LAST_QUESTION_ROW),
  });

  const order = ['q3', 'q12', 'q40'].map((q) => out.indexOf(q));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('a math only run does not report the Reading and Writing rows as empty', () => {
  // Rows 2-55 are legitimately untouched; listing 54 "missing" questions would
  // bury the two that actually are missing.
  const filled = allRows(FIRST_MATH_ROW, LAST_QUESTION_ROW).filter((r) => r !== 60);
  const out = report({ issues: [], filledRows: filled, scope: EXAM_SCOPE.MATH });

  assert.match(out, /1 row\(s\) empty/);
  assert.match(out, /row 60\s+Math module 1, question 5/);
  assert.ok(!out.includes('row 2 '), 'row 2 is not part of a math only run');
});

test('a Reading and Writing only run stops at row 55', () => {
  const out = report({
    issues: [],
    filledRows: allRows(2, 55).filter((r) => r !== 10),
    scope: EXAM_SCOPE.RW,
  });

  assert.match(out, /1 row\(s\) empty/);
  assert.ok(!out.includes(`row ${FIRST_MATH_ROW}`), 'math rows are not part of this run');
});

test('both kinds of problem appear together', () => {
  const filled = allRows(2, LAST_QUESTION_ROW).filter((r) => r !== 90);
  const out = report({
    issues: [{ row: 4, detail: 'only 2 of 4 choices — missing C, D', question: 'q4' }],
    filledRows: filled,
  });

  assert.match(out, /1 row\(s\) written with a problem/);
  assert.match(out, /1 row\(s\) empty/);
});

test('an issue on a row outside the template is still shown', () => {
  // It should never happen, but silently dropping it would hide a real bug.
  const out = report({ issues: [{ row: 400, detail: 'x', question: 'q' }], filledRows: allRows(2, LAST_QUESTION_ROW) });
  assert.match(out, /row 400/);
});
