// A PDF holding only the math modules, or only Reading and Writing.
//
// Nothing automatic can tell the difference. A math-only file starts its numbering
// at 1 with no Reading and Writing pages in front of it, so the structure pass
// reports the math section starting on page 1 — which detectMathStartPage rejects
// as impossible — and every page then reads as Reading and Writing. All 44 math
// questions land in rows 2-55 under the wrong section heading. So the user is
// asked instead, and the answer becomes the row window for the whole run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXAM_SCOPE, rowWindowFor, questionIsMath, pageIsMath, planPageWrite,
  placeQuestions, createRowAssigner,
  FIRST_MATH_ROW, LAST_QUESTION_ROW,
} from '../lib/pipeline.js';

const mathQ = (n) => ({ question_number: n, section: 'Math', question: `math ${n}` });
const rwQ = (n) => ({ question_number: n, section: 'Reading and Writing', question: `rw ${n}` });

test('each scope owns its own block of rows', () => {
  assert.deepEqual(rowWindowFor(EXAM_SCOPE.BOTH), { first: 2, last: LAST_QUESTION_ROW });
  assert.deepEqual(rowWindowFor(EXAM_SCOPE.RW), { first: 2, last: FIRST_MATH_ROW - 1 });
  assert.deepEqual(rowWindowFor(EXAM_SCOPE.MATH), { first: FIRST_MATH_ROW, last: LAST_QUESTION_ROW });
});

test('an unrecognised scope falls back to the whole sheet', () => {
  assert.deepEqual(rowWindowFor(undefined), { first: 2, last: LAST_QUESTION_ROW });
  assert.deepEqual(rowWindowFor('nonsense'), { first: 2, last: LAST_QUESTION_ROW });
});

test('a declared scope overrules what the page looks like', () => {
  // The page signals are exactly what got this wrong, so they must not win.
  assert.equal(pageIsMath([rwQ(1)], 1, null, EXAM_SCOPE.MATH), true);
  assert.equal(pageIsMath([mathQ(1)], 30, 20, EXAM_SCOPE.RW), false);

  assert.equal(questionIsMath(rwQ(1), false, EXAM_SCOPE.MATH), true);
  assert.equal(questionIsMath(mathQ(1), true, EXAM_SCOPE.RW), false);
});

test('a full exam still decides from the page', () => {
  assert.equal(pageIsMath([mathQ(1)], 30, 27, EXAM_SCOPE.BOTH), true);
  assert.equal(pageIsMath([rwQ(1)], 5, 27, EXAM_SCOPE.BOTH), false);
  assert.equal(questionIsMath(mathQ(1), false, EXAM_SCOPE.BOTH), true, 'the label alone is enough');
  assert.equal(questionIsMath(rwQ(1), true, EXAM_SCOPE.BOTH), true, 'so is the page');
});

test('a math-only file starts writing at row 56, not row 2', () => {
  // Page 1 of a math-only PDF. Under the old behaviour mathStartPage was null,
  // the page read as Reading and Writing, and question 1 went to row 2.
  const plan = planPageWrite({
    questions: [mathQ(1), mathQ(2)],
    pageNumber: 1,
    nextRow: 2,
    mathStartPage: null,
    scope: EXAM_SCOPE.MATH,
  });

  assert.equal(plan.action, 'write');
  assert.equal(plan.startRow, FIRST_MATH_ROW);
  assert.equal(plan.isMathPage, true);
});

test('a math-only file places its questions by number inside the math block', () => {
  const out = placeQuestions({
    rows: ['q1', 'q2', 'q3'],
    questions: [mathQ(1), mathQ(2), mathQ(3)],
    startRow: FIRST_MATH_ROW,
    isMathPage: true,
    assignRow: createRowAssigner(),
    taken: new Map(),
    scope: EXAM_SCOPE.MATH,
  });

  assert.deepEqual(out.claims.map((c) => c.row), [56, 57, 58]);
});

test('a Reading and Writing only file stops at row 55', () => {
  const plan = planPageWrite({
    questions: [rwQ(1), rwQ(2)],
    pageNumber: 1,
    nextRow: 55,
    mathStartPage: null,
    scope: EXAM_SCOPE.RW,
  });

  assert.equal(plan.action, 'write');
  assert.equal(plan.questions.length, 1, 'only one slot was left');
  assert.match(plan.notes.join(' '), /only 1 slot\(s\) remain before row 55/);
});

test('a Reading and Writing only file will not spill past its last row', () => {
  const plan = planPageWrite({
    questions: [rwQ(1)],
    pageNumber: 40,
    nextRow: FIRST_MATH_ROW,
    mathStartPage: null,
    scope: EXAM_SCOPE.RW,
  });

  assert.equal(plan.action, 'stop');
  assert.match(plan.notes.join(' '), /Row 55 is full/);
});

test('a question the model calls Math cannot escape a Reading and Writing only file', () => {
  // A graph-heavy Reading and Writing question gets labelled "Math" routinely.
  const out = placeQuestions({
    rows: ['q1'],
    questions: [mathQ(1)],
    startRow: 2,
    isMathPage: false,
    assignRow: createRowAssigner(),
    taken: new Map(),
    scope: EXAM_SCOPE.RW,
  });

  assert.deepEqual(out.claims.map((c) => c.row), [2]);
});

test('a full exam behaves exactly as it did before scopes existed', () => {
  const withScope = planPageWrite({
    questions: [mathQ(1)], pageNumber: 30, nextRow: 40, mathStartPage: 27, scope: EXAM_SCOPE.BOTH,
  });
  const withoutScope = planPageWrite({
    questions: [mathQ(1)], pageNumber: 30, nextRow: 40, mathStartPage: 27,
  });

  assert.deepEqual(withScope, withoutScope);
  assert.equal(withScope.startRow, FIRST_MATH_ROW);
});

test('a math-only file fills all 44 slots and no more', () => {
  const assign = createRowAssigner();
  const taken = new Map();
  let cursor = 2; // the sheet cursor starts low; the scope has to lift it

  for (let module = 0; module < 2; module += 1) {
    for (let n = 1; n <= 22; n += 1) {
      const plan = planPageWrite({
        questions: [mathQ(n)], pageNumber: module * 22 + n, nextRow: cursor,
        mathStartPage: null, scope: EXAM_SCOPE.MATH,
      });
      assert.equal(plan.action, 'write');

      const out = placeQuestions({
        rows: ['x'], questions: [mathQ(n)], startRow: plan.startRow,
        isMathPage: plan.isMathPage, assignRow: assign, taken, scope: EXAM_SCOPE.MATH,
      });
      for (const claim of out.claims) taken.set(claim.row, claim.values);
      cursor = out.nextCursor;
    }
  }

  assert.equal(taken.size, 44);
  assert.equal(Math.min(...taken.keys()), FIRST_MATH_ROW);
  assert.equal(Math.max(...taken.keys()), LAST_QUESTION_ROW);
});
