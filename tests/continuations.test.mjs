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

test('a complete question is never overwritten by a stray continuation', () => {
  // This assertion was reversed after a production run. Previously the tail
  // replaced the head's choices outright, to fix cases where the model invented
  // them. But the model also emits continuations on pages whose questions are
  // already complete, and overwriting then destroyed good data: a hermit crab
  // question came out with "C) these" taken from a grammar question two pages
  // away, and its real "19%" was gone. Once a question has all four choices
  // there is no way to tell invented ones from genuine ones, so the safe move is
  // to leave it alone. Inventing is now forbidden by the prompt instead.
  const complete = 'According to the table, what percentage of hermit crabs tried to flip the shell?\n\n'
    + 'A) 35%\nB) 0%\nC) 19%\nD) 70%';

  const out = mergePageContinuations([
    { image: 'page-42.png', questions: [head(complete)] },
    { image: 'page-43.png', questions: [tail('C) these', 'C')] },
  ]);

  const q = out[0].questions[0];
  assert.match(q.question, /C\) 19%/, 'the real choice must survive');
  assert.doesNotMatch(q.question, /these/, 'the stray tail must not bleed in');
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

// --- A numbered question is never a tail -------------------------------------
//
// On a one-question-per-page exam the model marks nearly every page as
// continuing the previous one, because each page opens partway through a
// passage. Those entries reached the continuation branch, found the previous
// question already complete, and were discarded outright. On 202603usv1 that
// deleted six whole questions — pages 4, 5, 10, 15, 37 and 48 each returned one
// numbered, complete question and ended up holding nothing.
//
// A real tail has lost its stem, and the printed number went with it. So an entry
// that names its own number is a question, whatever the model labelled it.

test('a numbered question flagged as a continuation is kept, not deleted', () => {
  const out = mergePageContinuations([
    { image: 'page-03.png', questions: [head('Which choice best states the main idea?\n\nA) one\nB) two\nC) three\nD) four', { question_number: 3 })] },
    { image: 'page-04.png', questions: [head('Which choice completes the text with the most logical transition?\n\nA) a\nB) b\nC) c\nD) d', { question_number: 4, continues_previous_page: true })] },
  ]);

  assert.equal(out[1].questions.length, 1, 'question 4 must survive');
  assert.equal(out[1].questions[0].question_number, 4);
  assert.match(out[1].questions[0].question, /most logical transition/);
});

test('the question it was wrongly attached to is left untouched', () => {
  const out = mergePageContinuations([
    { image: 'p3.png', questions: [head('Question three?\n\nA) one\nB) two\nC) three\nD) four', { question_number: 3 })] },
    { image: 'p4.png', questions: [head('Question four?\n\nA) w\nB) x\nC) y\nD) z', { question_number: 4, continues_previous_page: true })] },
  ]);

  assert.match(out[0].questions[0].question, /Question three\?/);
  assert.ok(!out[0].questions[0].question.includes('Question four'), 'nothing was merged in');
});

test('an unnumbered tail is still folded in as before', () => {
  // The rule must not stop genuine tails working — a tail lost its number along
  // with its stem, which is exactly what tells the two apart.
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [head('Which choice completes the text?\n\nA) one\nB) two')] },
    { image: 'p2.png', questions: [tail('C) three\nD) four')] },
  ]);

  assert.equal(out[1].questions.length, 0, 'the tail is consumed');
  assert.match(out[0].questions[0].question, /C\) three/);
});

test('a numbered orphan choice block is kept rather than absorbed', () => {
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [head('Complete question?\n\nA) one\nB) two\nC) three\nD) four', { question_number: 7 })] },
    { image: 'p2.png', questions: [head('A) w B) x C) y D) z', { question_number: 8 })] },
  ]);

  assert.equal(out[1].questions.length, 1, 'question 8 keeps its place in the run');
  assert.equal(out[1].questions[0].question_number, 8);
});

test('every page of a one-question-per-page exam survives', () => {
  // Ten pages, each a complete numbered question, every one flagged as a
  // continuation. Before the fix this returned one question.
  const pages = Array.from({ length: 10 }, (_, i) => ({
    image: `page-${i + 1}.png`,
    questions: [head(`Question ${i + 1}?\n\nA) one\nB) two\nC) three\nD) four`, {
      question_number: i + 1,
      continues_previous_page: i > 0,
    })],
  }));

  const out = mergePageContinuations(pages);
  const numbers = out.flatMap((p) => p.questions.map((q) => q.question_number));

  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
