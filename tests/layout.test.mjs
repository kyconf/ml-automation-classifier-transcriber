// Where a question lands in the sheet. The template reserves rows 2-55 for the
// two Reading and Writing modules and 56-99 for the two math modules, and both
// blocks have to be defended from the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planPageWrite,
  sectionFor,
  pageIsMath,
  pageNumberFromImage,
  questionHasChoiceGraphs,
  RW_QUESTION_COUNT,
  MATH_QUESTION_COUNT,
  FIRST_MATH_ROW,
  LAST_QUESTION_ROW,
  QUESTION_CAPACITY,
} from '../lib/pipeline.js';

const RW = (n) => Array(n).fill({ section: 'Reading and Writing' });
const MATH = (n) => Array(n).fill({ section: 'Math' });

test('the template constants describe a 98 question exam', () => {
  assert.deepEqual(
    [RW_QUESTION_COUNT, MATH_QUESTION_COUNT, FIRST_MATH_ROW, LAST_QUESTION_ROW, QUESTION_CAPACITY],
    [54, 44, 56, 99, 98],
  );
});

test('page numbers come off the rendered filename', () => {
  assert.deepEqual(
    ['page-01.png', 'page-5.png', 'page-99.png'].map((f) => pageNumberFromImage('/tmp/' + f)),
    [1, 5, 99],
  );
});

// Crossing into math skips the rest of the Reading and Writing block, so it takes
// two signals agreeing. The structure pass once named the last Reading and
// Writing page, which sent three questions into math's rows.
test('a page the structure pass misplaces stays in Reading and Writing', () => {
  assert.equal(pageIsMath(RW(3), 19, 19), false);
});

test('a page both signals call math crosses over', () => {
  assert.equal(pageIsMath(MATH(2), 20, 19), true);
});

test('no page before the structure boundary is ever math', () => {
  assert.equal(pageIsMath(MATH(2), 5, 19), false);
});

test('a mixed page follows its majority', () => {
  assert.equal(pageIsMath([...MATH(2), ...RW(1)], 20, 19), true);
  assert.equal(pageIsMath([...RW(2), ...MATH(1)], 20, 19), false);
});

test('the row decides the section, so Reading and Writing cannot exceed 54', () => {
  assert.equal(sectionFor(2), 'Reading and Writing');
  assert.equal(sectionFor(55), 'Reading and Writing');
  assert.equal(sectionFor(56), 'Math');
  assert.equal(sectionFor(99), 'Math');

  // Every row in the sheet, counted by the label it will carry.
  const labels = [];
  for (let row = 2; row <= 99; row += 1) labels.push(sectionFor(row));
  assert.equal(labels.filter((l) => l === 'Reading and Writing').length, 54);
  assert.equal(labels.filter((l) => l === 'Math').length, 44);
});

test('math starts in its own block even when Reading and Writing came up short', () => {
  // Two questions were lost to a failed page, so the cursor is at 54, not 56.
  const plan = planPageWrite({ questions: MATH(2), pageNumber: 21, nextRow: 54, mathStartPage: 21 });
  assert.equal(plan.action, 'write');
  assert.equal(plan.startRow, FIRST_MATH_ROW);
});

test('surplus Reading and Writing is dropped rather than pushing math out', () => {
  // The uploaded sheet had 58 Reading and Writing questions; math lost four.
  const plan = planPageWrite({ questions: RW(4), pageNumber: 20, nextRow: 56, mathStartPage: 21 });
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /overran/);
  assert.ok(plan.notes.some((n) => n.includes('dropped:')));
});

test('a math page misread as Reading and Writing is still written', () => {
  // Same overrun position, but the page is at the math boundary, so discarding it
  // would throw away real questions.
  const plan = planPageWrite({ questions: RW(2), pageNumber: 21, nextRow: 56, mathStartPage: 21 });
  assert.notEqual(plan.action, 'skip');
});

test('nothing is written past the last template row', () => {
  const plan = planPageWrite({ questions: MATH(2), pageNumber: 40, nextRow: 100, mathStartPage: 21 });
  assert.equal(plan.action, 'stop');
});

test('a page straddling the last row is truncated to fit', () => {
  const plan = planPageWrite({ questions: MATH(4), pageNumber: 40, nextRow: 98, mathStartPage: 21 });
  assert.equal(plan.action, 'write');
  assert.equal(plan.questions.length, 2);
  assert.equal(plan.dropped, 2);
});

test('picture answer choices are recognised from the marker', () => {
  assert.equal(questionHasChoiceGraphs({ question: '%CHOICES_GRAPH% Which graph?' }), true);
  assert.equal(questionHasChoiceGraphs({ question: 'Which choice completes the text?' }), false);
  assert.equal(questionHasChoiceGraphs({}), false);
});

// Full-exam walk: the sheet the pipeline produces end to end, in rows.
function layOutExam(pages, mathStartPage) {
  const rows = [];
  let cursor = 2;
  let droppedRW = 0;

  for (const page of pages) {
    const plan = planPageWrite({
      questions: page.questions,
      pageNumber: page.pageNumber,
      nextRow: cursor,
      mathStartPage,
    });
    if (plan.action === 'stop') break;
    if (plan.action === 'skip') { droppedRW += page.questions.length; continue; }

    plan.questions.forEach((_, i) => rows.push({
      row: plan.startRow + i,
      section: sectionFor(plan.startRow + i, plan.isMathPage, true),
    }));
    cursor = plan.startRow + plan.questions.length;
  }
  return { rows, droppedRW };
}

test('an over-long Reading and Writing section still leaves math its 44 rows', () => {
  // 58 Reading and Writing questions across 20 pages, then 22 math pages of 2.
  const pages = [
    ...Array.from({ length: 19 }, (_, i) => ({ pageNumber: i + 1, questions: RW(3) })),
    { pageNumber: 20, questions: RW(1) },
    ...Array.from({ length: 22 }, (_, i) => ({ pageNumber: 21 + i, questions: MATH(2) })),
  ];
  const { rows, droppedRW } = layOutExam(pages, 21);

  const rw = rows.filter((r) => r.section === 'Reading and Writing');
  const math = rows.filter((r) => r.section === 'Math');

  assert.equal(rw.length, RW_QUESTION_COUNT);
  assert.equal(math.length, MATH_QUESTION_COUNT);
  assert.equal(droppedRW, 4);
  assert.deepEqual([rw[0].row, rw.at(-1).row], [2, 55]);
  assert.deepEqual([math[0].row, math.at(-1).row], [FIRST_MATH_ROW, LAST_QUESTION_ROW]);
  assert.equal(rows.length, QUESTION_CAPACITY);
  assert.equal(new Set(rows.map((r) => r.row)).size, QUESTION_CAPACITY, 'no row written twice');
});

test('a one-question-per-page exam fills the sheet exactly', () => {
  // 99 pages of one question each — the format whose back half used to be cut off
  // by a hardcoded 54 page limit.
  const pages = Array.from({ length: 99 }, (_, i) => ({
    pageNumber: i + 1,
    questions: i < 54 ? RW(1) : MATH(1),
  }));
  const { rows } = layOutExam(pages, 55);
  assert.equal(rows.length, QUESTION_CAPACITY);
  assert.equal(rows.at(-1).row, LAST_QUESTION_ROW);
});
