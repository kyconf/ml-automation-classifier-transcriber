// The model is asked for a bare answer letter but frequently returns the choice's
// text instead. Every case below is a real correct_answer taken from a run log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAnswer, questionHasChoiceGraphs } from '../lib/pipeline.js';

const letter = (raw, choices) => normaliseAnswer(raw, choices).answer;

test('a bare letter is kept', () => {
  assert.equal(letter('B', ['w', 'x', 'y', 'z']), 'B');
  assert.equal(letter('c', ['w', 'x', 'y', 'z']), 'C');
});

test('the choice text is resolved back to its letter', () => {
  assert.equal(letter('26/49', ['1/49', '1/26', '26/49', '49/26']), 'C');
  assert.equal(letter('(21, 0)', ['(-21, 0)', '(-4, 0)', '(7, 0)', '(21, 0)']), 'D');
  assert.equal(letter('110', ['110', '220', '825', '1,100']), 'A');
  assert.equal(letter('15', ['1', '9', '15', '21']), 'C');
  assert.equal(letter('20', ['40', '20', '10', '\\sqrt{20}']), 'B');
  assert.equal(letter('39.17', ['39.17', '48', '52.22', '72.33']), 'A');
});

test('a long prose answer is resolved', () => {
  assert.equal(
    letter('The average number of trees per hectare in the park', [
      'The average number of trees per hectare in the park',
      'The average number of trees per hectare in the residential area',
      'The total number of trees in the park',
      'The total number of trees in the residential area',
    ]),
    'A',
  );
});

test('a LaTeX answer is resolved', () => {
  assert.equal(
    letter('\\cos L = \\sin K', [
      '$\\cos L > \\sin K$', '$\\cos L = \\sin K$', '$\\cos L < \\sin K$', 'There is not enough information',
    ]),
    'B',
  );
});

test('a letter with its text attached collapses to the letter', () => {
  // The exported sheet had "B) Ultimately," sitting in correct_answer.
  assert.equal(letter('B) Ultimately,', ['Similarly,', 'Ultimately,', 'By comparison,', 'In addition,']), 'B');
  assert.equal(letter('C. Thus,', ['Ultimately,', 'For example,', 'Thus,', 'Similarly,']), 'C');
  assert.equal(letter('A - By contrast,', ['By contrast,', 'Secondly,', 'Similarly,', 'Therefore,']), 'A');
});

test('a partial answer resolves when it matches only one choice', () => {
  assert.equal(letter('8, 0', ['(-1, 0)', '(3, 0)', '(7, 0)', '(8, 0)']), 'D');
});

test('a question with no choices keeps its value', () => {
  // Student-produced responses are Math only, and the value is the answer.
  assert.equal(letter('5900', []), '5900');
  assert.equal(letter('1.2', ['', '', '', '']), '1.2');
  assert.equal(letter('3/4', []), '3/4');
});

test('an answer matching nothing is left untouched and reported', () => {
  // "x+5" was returned for choices x+3, x+4, x-3, x-5 — the model was simply wrong,
  // and quietly rewriting it would hide that.
  const out = normaliseAnswer('x+5', ['x+3', 'x+4', 'x-3', 'x-5']);
  assert.equal(out.answer, 'x+5');
  assert.equal(out.matched, false);
});

test('an empty answer stays empty', () => {
  assert.equal(letter('', ['a', 'b', 'c', 'd']), '');
  assert.equal(letter(undefined, ['a', 'b', 'c', 'd']), '');
});

test('an ambiguous partial match is not guessed at', () => {
  const out = normaliseAnswer('0', ['(1, 0)', '(2, 0)', '(3, 0)', '(4, 0)']);
  assert.equal(out.matched, false);
});

test('two choices that normalise alike are never resolved to the first', () => {
  // Comparison is lossy by design — it has to see past $...$ and stray commas.
  // When that lossiness makes two choices indistinguishable the answer must be
  // reported unresolved, not silently assigned to whichever came first.
  const out = normaliseAnswer('x = 2', ['$x = 2$', 'x = 2', 'y = 3', 'z = 4']);
  assert.equal(out.matched, false, 'an ambiguous exact match must not be resolved');
  assert.equal(out.answer, 'x = 2', 'and the original answer must be preserved');
});

test('an unresolved answer is never replaced with a plausible letter', () => {
  for (const raw of ['x+5', 'not a choice at all', '42']) {
    const out = normaliseAnswer(raw, ['x+3', 'x+4', 'x-3', 'x-5']);
    assert.equal(out.matched, false, `${raw} should not resolve`);
    assert.equal(out.answer, raw, `${raw} should be handed back untouched`);
  }
});

test('the picture-choice marker is found in either field', () => {
  // The log shows it landing in passage as often as in question.
  assert.equal(questionHasChoiceGraphs({ question: '%CHOICES_GRAPH% Which table?' }), true);
  assert.equal(questionHasChoiceGraphs({ passage: '%CHOICES_GRAPH%', question: 'Which table?' }), true);
  assert.equal(questionHasChoiceGraphs({ passage: 'a passage', question: 'Which choice?' }), false);
});
