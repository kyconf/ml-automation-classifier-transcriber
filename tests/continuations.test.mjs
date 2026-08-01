// A question whose answer choices fall on the next page arrives as two entries.
// Left alone, the tail becomes a question in its own right: in one real exam
// that turned 54 Reading and Writing questions into 58 and pushed math out of
// its block. Every case below is taken from that run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePageContinuations, planPageWrite, sectionFor } from '../lib/pipeline.js';

const head = (question, extra = {}) => ({
  question_number: null,
  continues_previous_page: false,
  section: 'Reading and Writing',
  passage: 'a passage',
  question,
  correct_answer: 'A',
  ...extra,
});

const tail = (choices, answer = 'A') => ({
  question_number: null,
  continues_previous_page: true,
  section: 'Reading and Writing',
  passage: '',
  question: choices,
  correct_answer: answer,
});

test('a tail is folded into the question it belongs to', () => {
  const pages = [
    { image: 'page-02.png', questions: [head('Which choice best states the main purpose of the text?')] },
    { image: 'page-03.png', questions: [tail("A) To discuss how Chloe Zhao's background...\nB) To emphasize...\nC) To summarize...\nD) To argue that...")] },
  ];
  const out = mergePageContinuations(pages);

  assert.equal(out[0].questions.length, 1);
  assert.equal(out[1].questions.length, 0, 'the tail must not survive as its own question');
  assert.match(out[0].questions[0].question, /main purpose of the text/);
  assert.match(out[0].questions[0].question, /To discuss how Chloe Zhao/);
});

test('the real choices replace ones the model invented for the head', () => {
  // Row 8 of the exported sheet held "The text argues/describes/discusses/explains",
  // none of which were printed on the page.
  const invented = 'Which choice best states the main purpose of the text?\n\n'
    + 'A) The text argues\nB) The text describes\nC) The text discusses\nD) The text explains';
  const real = 'A) To discuss how...\nB) To emphasize...\nC) To summarize...\nD) To argue that...';

  const out = mergePageContinuations([
    { image: 'page-02.png', questions: [head(invented)] },
    { image: 'page-03.png', questions: [tail(real, 'B')] },
  ]);

  const q = out[0].questions[0];
  assert.doesNotMatch(q.question, /The text argues/, 'invented choices should be gone');
  assert.match(q.question, /To discuss how/);
  assert.equal(q.correct_answer, 'B', 'the tail carries the answer that matches the real choices');
});

test('the question count drops back to the true number', () => {
  // 54 genuine questions, four of them split across page breaks.
  const pages = [];
  for (let i = 0; i < 54; i += 1) {
    pages.push({ image: `page-${i}.png`, questions: [head(`Question ${i}?`)] });
    if ([7, 14, 30, 44].includes(i)) {
      pages.push({ image: `page-${i}b.png`, questions: [tail('A) one\nB) two\nC) three\nD) four')] });
    }
  }
  const before = pages.reduce((n, p) => n + p.questions.length, 0);
  const after = mergePageContinuations(pages).reduce((n, p) => n + p.questions.length, 0);

  assert.equal(before, 58, 'the raw transcription over-counts');
  assert.equal(after, 54, 'merging restores the true count');
});

test('after merging, Reading and Writing no longer overruns into math', () => {
  const pages = [];
  for (let i = 0; i < 54; i += 1) {
    pages.push({ pageNumber: i + 1, questions: [head(`Question ${i}?`)] });
    if ([7, 14, 30, 40].includes(i)) {
      pages.push({ pageNumber: i + 1, questions: [tail('A) one\nB) two\nC) three\nD) four')] });
    }
  }
  const merged = mergePageContinuations(pages);

  let cursor = 2;
  let overran = false;
  for (const page of merged) {
    if (!page.questions.length) continue;
    const plan = planPageWrite({
      questions: page.questions,
      pageNumber: page.pageNumber,
      nextRow: cursor,
      mathStartPage: 60,
    });
    if (plan.action === 'skip') { overran = true; break; }
    cursor = plan.startRow + plan.questions.length;
  }

  assert.equal(overran, false, 'no Reading and Writing question should be dropped');
  assert.equal(cursor, 56, 'the 54 questions end exactly at row 55');
  assert.equal(sectionFor(cursor), 'Math');
});

test('a leading tail with no preceding question is left alone', () => {
  // Nothing to merge into, so it must not crash or silently vanish into nothing.
  const out = mergePageContinuations([
    { image: 'page-01.png', questions: [tail('A) one\nB) two')] },
  ]);
  assert.equal(out[0].questions.length, 1);
});

test('pages that failed to transcribe are passed through untouched', () => {
  const out = mergePageContinuations([
    { image: 'page-01.png', questions: [head('Q?')] },
    { image: 'page-02.png', error: 'boom' },
    { image: 'page-03.png', questions: [tail('A) one')] },
  ]);
  assert.equal(out[1].error, 'boom');
  assert.equal(out[2].questions.length, 0);
});

test('an ordinary run is unchanged', () => {
  const pages = [
    { image: 'page-01.png', questions: [head('Q1?'), head('Q2?')] },
    { image: 'page-02.png', questions: [head('Q3?')] },
  ];
  const out = mergePageContinuations(pages);
  assert.deepEqual(out.map((p) => p.questions.length), [2, 1]);
});

test('merging does not mutate the input pages', () => {
  const pages = [
    { image: 'page-01.png', questions: [head('Q1?')] },
    { image: 'page-02.png', questions: [tail('A) one')] },
  ];
  mergePageContinuations(pages);
  assert.equal(pages[1].questions.length, 1, 'the caller\'s array must be intact');
});
