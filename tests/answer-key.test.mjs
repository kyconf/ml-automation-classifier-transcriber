// Practice exams print the answer key on the last pages. It must never be
// transcribed: its pages come back as entries and its letters land in the sheet
// as exam content. The hard case is the boundary page, where the key starts a few
// centimetres below the last real question, so the page cannot simply be skipped.
//
// Every string below is taken from pages 34-36 of 202603asiav1.pdf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnswerKeyBlock, stripAnswerKeyEntries } from '../lib/pipeline.js';

const q = (question, extra = {}) => ({
  question_number: null,
  continues_previous_page: false,
  section: 'Math',
  passage: '',
  question,
  correct_answer: 'B',
  ...extra,
});

const RW_MODULE_1_KEY = `Reading and Writing Module 1 Answers

1. A
2. C
3. A
4. D
5. C
6. B`;

const MATH_KEY_TAIL = `6. 1.2
7. D
8. B
9. 208
10. 15
16. 10
19. 5.5
20. 485`;

test('a module heading on a question page is not the key', () => {
  // Exam pages carry "Math Module 1" as a running header. Only "... Answers"
  // marks the key; matching the heading alone would delete every question in the
  // module from the sheet.
  assert.equal(
    isAnswerKeyBlock(q('Math Module 1\n\nIf $6 + x = 70$, what is the value of $48 + 8x$?')),
    false,
  );
});

test('each module heading the exams actually print is recognised', () => {
  for (const heading of [
    'Reading and Writing Module 1 Answers',
    'Reading and Writing Module 2 Answers',
    'Math Module 1 Answers',
    'Math Module 2 Answers',
    'MATH MODULE 2 ANSWERS',
    'Answer Key',
  ]) {
    assert.equal(isAnswerKeyBlock(q(heading)), true, `should match: ${heading}`);
  }
});

test('a transcribed key block is recognised by its heading', () => {
  assert.equal(isAnswerKeyBlock(q(RW_MODULE_1_KEY)), true);
});

test('a headless run of key lines is recognised too', () => {
  // Page 35 opens mid-list: the heading is on the page before it.
  assert.equal(isAnswerKeyBlock(q(MATH_KEY_TAIL)), true);
  assert.equal(isAnswerKeyBlock(q('21. D\n22. C\n23. D\n24. D\n25. B')), true);
});

test('three key lines is the shortest run that counts', () => {
  assert.equal(isAnswerKeyBlock(q('20. D\n21. A\n22. A')), true);
  assert.equal(isAnswerKeyBlock(q('21. A\n22. A')), false, 'two could be anything');
});

test('the key is caught in the passage field as well as the question', () => {
  assert.equal(isAnswerKeyBlock({ passage: RW_MODULE_1_KEY, question: '' }), true);
});

test('real questions are never mistaken for the key', () => {
  const real = [
    'If $6+x=70$, what is the value of $48+8x$?',
    'Which choice completes the text with the most logical transition?\n\nA) Likewise,\nB) Next,\nC) In reality,\nD) In other words,',
    'A length of 590 meters is equal to how many decimeters? (1 meter = 10 decimeters)',
    // Numbered answer choices — the shape closest to a key that a question takes.
    '$x^2-20x=0$\n\nWhich of the following is a solution?\n\nA) 40\nB) 20\nC) 10\nD) $\\sqrt{20}$',
    // A table transcribed as a list of numbers, with a stem above it.
    'The table shows three values.\n\n1. 46\n2. 16\n\nWhat is the value of $a + b$?',
  ];
  for (const text of real) {
    assert.equal(isAnswerKeyBlock(q(text)), false, `should not be the key: ${text.slice(0, 45)}`);
  }
});

test('a question whose table flattens into numbered lines is still a question', () => {
  // The commuter train question from this exam, with its two-column table
  // flattened. Three lines are indistinguishable from key lines on their own —
  // it is only that the rest of the block is prose and answer choices that keeps
  // the question. Without that check this row is deleted from the sheet.
  const flattened = [
    'The table shows the linear relationship between the number of cars, $c$, and the maximum number of passengers and crew, $p$.',
    '3. 139',
    '6. 271',
    '10. 447',
    'Which equation represents the linear relationship between $c$ and $p$?',
    'A) $44c-p=-7$',
    'B) $44c-p=7$',
  ].join('\n');

  assert.equal(isAnswerKeyBlock(q(flattened)), false);
});

test('the key is still caught when a stray line rides along with it', () => {
  // Page 35 opens with the tail of the previous page's last choice, then the key.
  const strayThenKey = [
    'D) There is not enough information to compare the values of cos L and sin K',
    '21. D', '22. C', '23. D', '24. D', '25. B', '26. A', '27. C',
  ].join('\n');

  assert.equal(isAnswerKeyBlock(q(strayThenKey)), true);
});

test('an empty entry is not the key', () => {
  assert.equal(isAnswerKeyBlock(q('')), false);
  assert.equal(isAnswerKeyBlock({}), false);
  assert.equal(isAnswerKeyBlock(undefined), false);
});

test('the boundary page keeps its questions and loses the key', () => {
  // Page 34: math questions 21 and 22, then "Reading and Writing Module 1
  // Answers" and twenty letters. Skipping the whole page would cost two real
  // questions; keeping it whole would write the key into the sheet.
  const kept = stripAnswerKeyEntries([
    q('Trapezoid $ABCD$ is similar to trapezoid $EFGH$. What is the length of side $EF$?', { question_number: 21 }),
    q('In triangle JKL, which of the following must be true?\n\nA) $\\cos L > \\sin K$\nB) $\\cos L = \\sin K$\nC) $\\cos L < \\sin K$\nD) There is not enough information', { question_number: 22 }),
    q(RW_MODULE_1_KEY),
  ], 'page-34.png');

  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((entry) => entry.question_number), [21, 22]);
});

test('a page of nothing but key is emptied', () => {
  assert.deepEqual(stripAnswerKeyEntries([q(RW_MODULE_1_KEY), q(MATH_KEY_TAIL)], 'page-35.png'), []);
});

test('a page with no key survives untouched', () => {
  const questions = [q('If $6+x=70$, what is the value of $48+8x$?')];
  assert.deepEqual(stripAnswerKeyEntries(questions, 'page-21.png'), questions);
});
