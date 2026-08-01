// Orphaned answer choices written as questions in their own right. Every string
// below is the literal content of a row from a real export, where the question
// it belonged to had lost its choices and every row after it had shifted down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOrphanChoiceBlock, mergePageContinuations } from '../lib/pipeline.js';

const q = (question, extra = {}) => ({
  question_number: null,
  continues_previous_page: false,
  section: 'Math',
  passage: '',
  question,
  correct_answer: 'B',
  ...extra,
});

test('the orphan rows from the export are recognised', () => {
  const rows = [
    'C) $f(x) = 980 \\left( \\frac13 \\right)^\\frac{x}{25}$ D) $f(x) = 980(3)^{x}$',
    'A) (-1, 0) B) (3, 0) C) (7, 0) D) (8, 0)',
    'A) The average number of trees per hectare in the park B) The average number per hectare in the residential area',
    'A) $y = 2(x^2 - 12x) + 54$ B) $y = 2x(x - 12) + 54$ C) $y = 2(x - 3)(x - 9)$',
    'A) $g(x) = 24(7)^x$ B) $g(x) = 588(7)^x$ C) $g(x) = 24(14)^x$',
    'A) - 23 B) 13 C) 81',
  ];
  for (const row of rows) {
    assert.equal(isOrphanChoiceBlock(q(row)), true, `should be an orphan: ${row.slice(0, 40)}`);
  }
});

test('genuine questions are never mistaken for orphans', () => {
  const rows = [
    'If $6 + x = 70$, what is the value of $48 + 8x$?',
    'Which choice completes the text with the most logical transition?',
    'What is the value of $a$?',
    'A length of 590 meters is equal to how many decimeters? (1 meter = 10 decimeters)',
    'Which choice best states the main purpose of the text?\n\nA) one\nB) two\nC) three\nD) four',
  ];
  for (const row of rows) {
    assert.equal(isOrphanChoiceBlock(q(row)), false, `should not be an orphan: ${row.slice(0, 40)}`);
  }
});

test('a single lone marker is not treated as an orphan block', () => {
  // "A) something" on its own is too weak a signal to discard a row over.
  assert.equal(isOrphanChoiceBlock(q('A) the only line here')), false);
});

test('an orphan in the passage field is caught too', () => {
  assert.equal(isOrphanChoiceBlock({ passage: 'A) one B) two C) three', question: '' }), true);
});

test('an empty entry is not an orphan', () => {
  assert.equal(isOrphanChoiceBlock(q('')), false);
  assert.equal(isOrphanChoiceBlock({}), false);
});

test('an orphan is folded into the question above it', () => {
  // The Bacillus question kept its stem; its choices arrived as the next entry.
  const pages = [
    { image: 'page-22.png', questions: [q('Which function f best represents the number of cells?')] },
    { image: 'page-23.png', questions: [q('A) $f(x) = 980(2)^x$ B) $f(x) = 980(3)^x$ C) $f(x) = 980(4)^x$')] },
  ];
  const out = mergePageContinuations(pages);

  assert.equal(out[1].questions.length, 0, 'the orphan must not remain a question');
  assert.match(out[0].questions[0].question, /best represents the number of cells/);
  assert.match(out[0].questions[0].question, /980\(2\)\^x/);
});

test('orphans on the same page as their question are merged', () => {
  // These were not page splits at all — both entries came back from one page.
  const out = mergePageContinuations([
    {
      image: 'page-24.png',
      questions: [
        q('What is the $x$-intercept of the graph of $y = v(x)$?'),
        q('A) (-1, 0) B) (3, 0) C) (7, 0) D) (8, 0)'),
        q('For the polynomial function $f$, which must be a factor?'),
      ],
    },
  ]);

  assert.equal(out[0].questions.length, 2, 'three entries were really two questions');
  assert.match(out[0].questions[0].question, /intercept/);
  assert.match(out[0].questions[0].question, /\(8, 0\)/);
  assert.match(out[0].questions[1].question, /polynomial/);
});

test('removing the orphans brings the count back to the real one', () => {
  // Six orphan rows in the math block pushed six real questions off the end.
  const pages = [];
  for (let i = 0; i < 44; i += 1) {
    pages.push({ image: `page-${i}.png`, questions: [q(`Real question ${i}?`)] });
    if ([3, 9, 14, 22, 30, 38].includes(i)) {
      pages.push({ image: `page-${i}b.png`, questions: [q('A) one B) two C) three D) four')] });
    }
  }
  const before = pages.reduce((n, p) => n + p.questions.length, 0);
  const after = mergePageContinuations(pages).reduce((n, p) => n + p.questions.length, 0);

  assert.equal(before, 50);
  assert.equal(after, 44);
});
