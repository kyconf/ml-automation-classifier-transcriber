// A page break between a question's number and the question itself.
//
// The numbered box sits at the very bottom of one page and the prompt starts
// overleaf. The transcriber reports that faithfully — a numbered entry with no
// text, then a texted entry with no number — and both halves were then wrong:
// the empty one took the question's row and stayed blank, and the real question,
// having no number, fell through to the running cursor, took the NEXT question's
// row, and pushed that question off the sheet.
//
// The entries below are copied from the run log of 202603asiav1_removed, where
// this cost questions 4, 10, 16, 20 and 26 — one at each page break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejoinDanglingNumbers, isBareQuestionNumber } from '../lib/pipeline.js';

const q = (number, question, extra = {}) => ({
  question_number: number,
  continues_previous_page: false,
  section: 'Reading and Writing',
  passage: '',
  question,
  ...extra,
});

const page = (image, questions) => ({ image, questions });
const numbersOf = (out) => out.map((p) => p.questions.map((x) => x.question_number));

test('a number with no question text is recognised', () => {
  assert.equal(isBareQuestionNumber(q(4, '')), true);
  assert.equal(isBareQuestionNumber(q(4, '   ')), true);
  assert.equal(isBareQuestionNumber({ question_number: 4, passage: '4', question: '' }), true);
});

test('a real question is never mistaken for a bare number', () => {
  assert.equal(isBareQuestionNumber(q(4, 'Which choice completes the text?')), false);
  assert.equal(isBareQuestionNumber(q(16, 'A circle has a circumference of $10\\pi$. What is the diameter?')), false);
  assert.equal(isBareQuestionNumber(q(null, '')), false, 'no number means nothing to carry');
  assert.equal(isBareQuestionNumber(undefined), false);
});

test('a number stranded at the foot of a page goes to the next page', () => {
  // page-01 ended with the box for question 4; page-02 opened with its text.
  const out = rejoinDanglingNumbers([
    page('page-01.png', [q(1, 'Apollo'), q(2, 'Billie Jean King'), q(3, 'coralline algae'), q(4, '')]),
    page('page-02.png', [q(null, 'The traditional Puerto Rican dish mofongo'), q(5, 'Colonel\'s Dream')]),
  ]);

  assert.deepEqual(numbersOf(out), [[1, 2, 3], [4, 5]]);
  assert.equal(out[0].questions.length, 3, 'the empty entry must not become a row');
  assert.match(out[1].questions[0].question, /mofongo/);
});

test('question 5 keeps its own row instead of being pushed out', () => {
  // The whole point. Before the fix mofongo took row 6 — question 5's slot — and
  // the Chesnutt question had nowhere to go.
  const out = rejoinDanglingNumbers([
    page('p1.png', [q(3, 'algae'), q(4, '')]),
    page('p2.png', [q(null, 'mofongo'), q(5, 'Chesnutt'), q(6, 'Uffington')]),
  ]);

  const [, second] = out;
  assert.deepEqual(second.questions.map((x) => [x.question_number, x.question]), [
    [4, 'mofongo'], [5, 'Chesnutt'], [6, 'Uffington'],
  ]);
});

test('a carried number never overwrites one the page already prints', () => {
  const out = rejoinDanglingNumbers([
    page('p1.png', [q(4, '')]),
    page('p2.png', [q(9, 'a question that names itself')]),
  ]);

  assert.deepEqual(numbersOf(out), [[], [9]]);
});

test('a carried number does not reach past the first question on the next page', () => {
  const out = rejoinDanglingNumbers([
    page('p1.png', [q(4, '')]),
    page('p2.png', [q(5, 'has a number'), q(null, 'does not')]),
  ]);

  // The second entry is filled by order (5 + 1), not by the stale carry.
  assert.deepEqual(numbersOf(out), [[], [5, 6]]);
});

test('a continuation tail is skipped over rather than numbered', () => {
  // The tail belongs to the previous page's question; the carried number belongs
  // to the first question that actually begins here.
  const out = rejoinDanglingNumbers([
    page('p1.png', [q(4, '')]),
    page('p2.png', [
      q(null, 'C) three D) four', { continues_previous_page: true }),
      q(null, 'the question the number belongs to'),
    ]),
  ]);

  assert.deepEqual(numbersOf(out), [[], [null, 4]]);
});

test('a numberless question between two numbered ones is filled in', () => {
  const out = rejoinDanglingNumbers([
    page('p1.png', [q(7, 'seven'), q(null, 'eight'), q(9, 'nine')]),
  ]);

  assert.deepEqual(numbersOf(out), [[7, 8, 9]]);
});

test('a guess is refused when another question already claims that number', () => {
  // Guessing 8 here would evict the real question 8 further down the page.
  const out = rejoinDanglingNumbers([
    page('p1.png', [q(7, 'seven'), q(null, 'something else'), q(8, 'the real eight')]),
  ]);

  assert.deepEqual(numbersOf(out), [[7, null, 8]]);
});

test('a page opening with no number at all is left alone', () => {
  // Nothing was carried, so there is nothing to reason from.
  const out = rejoinDanglingNumbers([
    page('p1.png', [q(null, 'no idea which question this is'), q(12, 'twelve')]),
  ]);

  assert.deepEqual(numbersOf(out), [[null, 12]]);
});

test('a page that failed to transcribe is passed through untouched', () => {
  const pages = [{ image: 'p1.png', error: 'boom' }, page('p2.png', [q(1, 'one')])];
  const out = rejoinDanglingNumbers(pages);

  assert.equal(out[0].error, 'boom');
  assert.deepEqual(out[1].questions.map((x) => x.question_number), [1]);
});

test('the input pages are not mutated', () => {
  const original = page('p2.png', [q(null, 'mofongo')]);
  rejoinDanglingNumbers([page('p1.png', [q(4, '')]), original]);

  assert.equal(original.questions[0].question_number, null, 'the caller\'s entry must be untouched');
});

test('every page break in the real run is repaired', () => {
  // Questions 4, 10, 16, 20 and 26 were each stranded this way.
  const pages = [];
  let n = 1;
  for (const stranded of [4, 10, 16, 20, 26]) {
    const body = [];
    while (n < stranded) body.push(q(n++, `question ${n - 1}`));
    body.push(q(stranded, '')); // the bare number closing the page
    pages.push(page(`page-${stranded}.png`, body));
    pages.push(page(`page-${stranded}b.png`, [q(null, `question ${stranded}`)]));
    n = stranded + 1;
  }

  const out = rejoinDanglingNumbers(pages);
  const all = out.flatMap((p) => p.questions.map((x) => x.question_number));

  assert.deepEqual(all, Array.from({ length: 26 }, (_, i) => i + 1), 'no number is missing or repeated');
});
