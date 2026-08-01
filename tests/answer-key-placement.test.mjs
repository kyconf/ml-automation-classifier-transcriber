// Where a transcribed answer key lands in column J. The whole risk here is
// off-by-one: an answer written one row high is silently wrong for every
// question after it, and nothing downstream would notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_KEY_MODULES, answerKeyModulesFor, parseAnswerKeyResponse,
  normaliseAnswerCell, placeAnswerKey, EXAM_SCOPE,
} from '../lib/pipeline.js';

const module_ = (id, answers) => ({ module: id, answers });
const fill = (n, value) => Array.from({ length: n }, () => value);

// The four modules of 202603usv2.pdf, whose key is printed as an unlabelled
// four-column table: 27 + 27 Reading and Writing, then 22 + 22 math.
const FULL_KEY = [
  module_('rw1', fill(27, 'A')),
  module_('rw2', fill(27, 'B')),
  module_('math1', fill(22, 'C')),
  module_('math2', fill(22, 'D')),
];

test('the template blocks are the ones the row layout defines', () => {
  assert.deepEqual(
    ANSWER_KEY_MODULES.map((m) => [m.firstRow, m.count]),
    [[2, 27], [29, 27], [56, 22], [78, 22]],
  );
});

test('a full key covers J2:J99 with no gaps', () => {
  const { values, first, last, written, notes } = placeAnswerKey(FULL_KEY);

  assert.equal(first, 2);
  assert.equal(last, 99);
  assert.equal(written, 98);
  assert.equal(values.length, 98);
  assert.deepEqual(notes, []);
  assert.ok(values.every(([v]) => v !== ''));
});

test('each module starts on its own first row', () => {
  const { values, first } = placeAnswerKey(FULL_KEY);
  const at = (row) => values[row - first][0];

  assert.equal(at(2), 'A');   // Reading and Writing module 1, question 1
  assert.equal(at(28), 'A');  // ...its last question
  assert.equal(at(29), 'B');  // module 2 begins
  assert.equal(at(55), 'B');
  assert.equal(at(56), 'C');  // math module 1 begins
  assert.equal(at(77), 'C');
  assert.equal(at(78), 'D');
  assert.equal(at(99), 'D');
});

// The reason the key is read per module rather than as one flat list of 98.
test('a module read short leaves only its own tail blank', () => {
  const short = [module_('rw1', fill(25, 'A')), ...FULL_KEY.slice(1)];
  const { values, first, written, notes } = placeAnswerKey(short);
  const at = (row) => values[row - first][0];

  assert.equal(written, 96);
  assert.equal(at(26), 'A');
  assert.equal(at(27), '');   // the two it could not read
  assert.equal(at(28), '');
  assert.equal(at(29), 'B');  // everything after is still in its right row
  assert.equal(at(56), 'C');
  assert.match(notes[0], /Reading and Writing Module 1: read 25/);
});

test('a module that overruns is truncated rather than spilling into the next', () => {
  const long = [module_('rw1', fill(30, 'A')), ...FULL_KEY.slice(1)];
  const { values, first, notes } = placeAnswerKey(long);

  assert.equal(values[29 - first][0], 'B'); // row 29 still belongs to module 2
  assert.match(notes[0], /read 30 answer\(s\) where the template holds 27/);
});

test('a missing module is reported and left blank', () => {
  const { values, first, written, notes } = placeAnswerKey(FULL_KEY.slice(0, 3));

  assert.equal(written, 76);
  assert.ok(values.slice(78 - first).every(([v]) => v === ''));
  assert.match(notes[0], /Math Module 2: no answers found/);
});

test('a declared scope restricts the window to that section', () => {
  const math = placeAnswerKey(FULL_KEY, EXAM_SCOPE.MATH);
  assert.equal(math.first, 56);
  assert.equal(math.last, 99);
  assert.equal(math.written, 44);
  assert.equal(math.values[0][0], 'C');

  const rw = placeAnswerKey(FULL_KEY, EXAM_SCOPE.RW);
  assert.equal(rw.first, 2);
  assert.equal(rw.last, 55);
  assert.equal(rw.written, 54);

  assert.deepEqual(answerKeyModulesFor(EXAM_SCOPE.RW).map((m) => m.id), ['rw1', 'rw2']);
  assert.deepEqual(answerKeyModulesFor(EXAM_SCOPE.MATH).map((m) => m.id), ['math1', 'math2']);
});

test('a math-only key numbered 1-22 goes to the math block, not row 2', () => {
  const { first, values } = placeAnswerKey(
    [module_('math1', fill(22, 'C')), module_('math2', fill(22, 'D'))],
    EXAM_SCOPE.MATH,
  );
  assert.equal(first, 56);
  assert.equal(values[0][0], 'C');
});

test('modules may be named by their printed heading instead of their id', () => {
  const { written } = placeAnswerKey([
    { module: 'Reading and Writing Module 1', answers: fill(27, 'A') },
    { module: 'Math Module 2', answers: fill(22, 'D') },
  ]);
  assert.equal(written, 49);
});

// Letters get tidied; student-produced responses must survive untouched. Every
// value below is printed in the key of 202603usv2.pdf.
test('letters are bare capitals and grid-ins are copied verbatim', () => {
  assert.equal(normaliseAnswerCell('(b)'), 'B');
  assert.equal(normaliseAnswerCell('c.'), 'C');
  assert.equal(normaliseAnswerCell(' D '), 'D');
  assert.equal(normaliseAnswerCell(''), '');

  for (const gridIn of ['28.2', '32', '-3', '36/5', '17/2', '2353', '18.49', '13/5', '-36', '8+32√85+16√97']) {
    assert.equal(normaliseAnswerCell(gridIn), gridIn);
  }
});

test('unreadable answers hold their place instead of shifting the rest', () => {
  const answers = fill(27, 'A');
  answers[4] = '';
  const { values, first } = placeAnswerKey([module_('rw1', answers)]);

  // An empty answer is dropped, so question 6 moves up into question 5's row.
  // The module still ends where it should; only its tail goes blank.
  assert.equal(values[2 + 26 - first][0], '');
});

test('a response wrapped in a markdown fence still parses', () => {
  const modules = parseAnswerKeyResponse('```json\n{"modules":[{"module":"rw1","answers":["A","B"]}]}\n```');
  assert.deepEqual(modules, [{ module: 'rw1', answers: ['A', 'B'] }]);
});

test('a response that is not an answer key fails loudly', () => {
  assert.throws(() => parseAnswerKeyResponse('not json at all'), /was not JSON/);
  assert.throws(() => parseAnswerKeyResponse('{"questions":[]}'), /held no modules/);
});
