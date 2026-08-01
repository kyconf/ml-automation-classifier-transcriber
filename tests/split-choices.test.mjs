// A page break can fall anywhere in the list of answer choices. Whichever side
// of the break each choice lands on, all four have to survive into one question.
// Row 27 of a real export lost "A) circumscribed" because the merge replaced the
// head's choices instead of combining them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractChoices, parseQuestion, mergePageContinuations, normaliseAnswer } from '../lib/pipeline.js';

const entry = (question, extra = {}) => ({
  question_number: null,
  continues_previous_page: false,
  section: 'Reading and Writing',
  passage: '',
  question,
  correct_answer: 'B',
  ...extra,
});

const choicesOf = (q) => {
  const p = parseQuestion(q);
  return [p.choiceA, p.choiceB, p.choiceC, p.choiceD];
};

test('choices separated by spaces rather than newlines are still found', () => {
  // A page break flattens the list onto one line.
  const { choices } = extractChoices('B) multifaceted C) undiscerning D) exuberant');
  assert.deepEqual(
    [choices.A, choices.B, choices.C, choices.D],
    ['', 'multifaceted', 'undiscerning', 'exuberant'],
  );
});

test('the stem is kept separate from the choices', () => {
  const { stem, choices } = extractChoices('Which choice completes the text?\n\nA) one\nB) two');
  assert.equal(stem, 'Which choice completes the text?');
  assert.equal(choices.A, 'one');
});

test('a break after A keeps A and gains B, C and D', () => {
  // The Kautsky question: "A) circumscribed" closed one page, B/C/D opened the next.
  const out = mergePageContinuations([
    { image: 'page-19.png', questions: [entry('Which choice completes the text?\n\nA) circumscribed')] },
    { image: 'page-20.png', questions: [entry('B) multifaceted C) undiscerning D) exuberant')] },
  ]);

  assert.equal(out[1].questions.length, 0);
  assert.deepEqual(
    choicesOf(out[0].questions[0].question),
    ['circumscribed', 'multifaceted', 'undiscerning', 'exuberant'],
  );
});

test('a break after B keeps both A and B', () => {
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [entry('Which choice?\n\nA) one\nB) two')] },
    { image: 'p2.png', questions: [entry('C) three D) four')] },
  ]);
  assert.deepEqual(choicesOf(out[0].questions[0].question), ['one', 'two', 'three', 'four']);
});

test('a break before any choice takes all four from the tail', () => {
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [entry('Which choice completes the text?')] },
    { image: 'p2.png', questions: [entry('A) one B) two C) three D) four')] },
  ]);
  assert.deepEqual(choicesOf(out[0].questions[0].question), ['one', 'two', 'three', 'four']);
});

test('a tail is refused when the head already has every choice', () => {
  // See the note in continuations.test.mjs: overwriting a complete question
  // corrupted real data in a run, so a tail may only fill gaps.
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [entry('Which choice?\n\nA) one\nB) two\nC) three\nD) four')] },
    { image: 'p2.png', questions: [entry('A) other B) other C) other D) other')] },
  ]);
  assert.deepEqual(choicesOf(out[0].questions[0].question), ['one', 'two', 'three', 'four']);
});

test('a tail still fills a genuine gap', () => {
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [entry('Which choice?\n\nA) one\nB) two')] },
    { image: 'p2.png', questions: [entry('C) three D) four')] },
  ]);
  assert.deepEqual(choicesOf(out[0].questions[0].question), ['one', 'two', 'three', 'four']);
});

test('the stem survives the merge', () => {
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [entry('Which choice completes the text with the most logical and precise word or phrase?\n\nA) circumscribed')] },
    { image: 'p2.png', questions: [entry('B) multifaceted C) undiscerning D) exuberant')] },
  ]);
  assert.match(out[0].questions[0].question, /^Which choice completes the text with the most logical and precise word or phrase\?/);
});

test('the rejoined question resolves its answer letter', () => {
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [entry('Which choice?\n\nA) circumscribed', { correct_answer: 'multifaceted' })] },
    { image: 'p2.png', questions: [entry('B) multifaceted C) undiscerning D) exuberant', { correct_answer: 'multifaceted' })] },
  ]);
  const q = out[0].questions[0];
  assert.equal(normaliseAnswer(q.correct_answer, choicesOf(q.question)).answer, 'B');
});

test('a question that was never split keeps all four choices', () => {
  const out = mergePageContinuations([
    { image: 'p1.png', questions: [entry('Which choice?\n\nA) one\nB) two\nC) three\nD) four')] },
  ]);
  assert.deepEqual(choicesOf(out[0].questions[0].question), ['one', 'two', 'three', 'four']);
});
