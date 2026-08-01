// Rows that came out of a real run with a blank content cell and no choices.
// Two causes: the model put the whole question in the passage, or a page break
// left the choices starting partway down the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestion, salvageQuestionFields } from '../lib/pipeline.js';

test('choices starting at C are still parsed', () => {
  // Row 40: A and B were printed on the previous page.
  const blob = 'Which statement, if true, would most strongly support the underlined claim?\n\n'
    + 'C) Participants were more likely to gesture\nD) Gestures varied widely between groups';
  const out = parseQuestion(blob);

  assert.equal(out.stem, 'Which statement, if true, would most strongly support the underlined claim?');
  assert.equal(out.choiceA, '');
  assert.equal(out.choiceB, '');
  assert.equal(out.choiceC, 'Participants were more likely to gesture');
  assert.equal(out.choiceD, 'Gestures varied widely between groups');
});

test('choices starting at B are still parsed', () => {
  const out = parseQuestion('Which choice completes the text?\n\nB) second\nC) third\nD) fourth');
  assert.deepEqual(
    [out.choiceA, out.choiceB, out.choiceC, out.choiceD],
    ['', 'second', 'third', 'fourth'],
  );
});

test('a full set of choices is unaffected', () => {
  const out = parseQuestion('Which choice?\n\nA) one\nB) two\nC) three\nD) four');
  assert.deepEqual(
    [out.choiceA, out.choiceB, out.choiceC, out.choiceD],
    ['one', 'two', 'three', 'four'],
  );
});

test('a question with no choices keeps its whole stem', () => {
  const blob = 'If $3x + 7 = 22$, what is the value of $x$?';
  const out = parseQuestion(blob);
  assert.equal(out.stem, blob);
  assert.deepEqual([out.choiceA, out.choiceB, out.choiceC, out.choiceD], ['', '', '', '']);
});

test('a question buried in the passage is split back out', () => {
  // Rows 27 and 37: content was blank because "question" came back empty.
  const q = {
    passage: 'While researching a topic, a student has taken the following notes:\n\n'
      + '- Shanawdithit was a Beothuk cartographer.\n\n'
      + 'The student wants to describe her approach. Which choice most effectively does this?',
    question: '',
    correct_answer: 'A',
  };
  const out = salvageQuestionFields(q);

  assert.equal(out.question, 'Which choice most effectively does this?');
  assert.match(out.passage, /Shanawdithit was a Beothuk cartographer/);
  assert.doesNotMatch(out.passage, /Which choice most effectively/);
});

test('the passage keeps the notes a rhetorical synthesis question needs', () => {
  const q = {
    passage: 'While researching a topic, a student has taken the following notes:\n\n- Fact one.\n\n- Fact two.\n\nWhich choice best states this?',
    question: '',
    correct_answer: 'B',
  };
  const out = salvageQuestionFields(q);
  assert.match(out.passage, /Fact one/);
  assert.match(out.passage, /Fact two/);
  assert.equal(out.question, 'Which choice best states this?');
});

test('a passage with no prompt sentence becomes the question outright', () => {
  // Better a populated content cell than a blank one.
  const out = salvageQuestionFields({ passage: 'The expression 13x^3 + 19x^3 - 17x^3 is equivalent to bx^3.', question: '' });
  assert.match(out.question, /13x\^3/);
  assert.equal(out.passage, '');
});

test('a question that is already present is left completely alone', () => {
  const q = { passage: 'a passage', question: 'Which choice?', correct_answer: 'A' };
  assert.deepEqual(salvageQuestionFields(q), q);
});

test('an entry with neither field is returned unchanged', () => {
  const q = { passage: '', question: '', correct_answer: '' };
  assert.deepEqual(salvageQuestionFields(q), q);
});

test('salvaging then parsing yields a populated row', () => {
  // End to end: the blank-content case now produces a stem and four choices.
  const raw = {
    passage: 'Some notes here. Which choice most effectively completes the text?\n\nA) one\nB) two\nC) three\nD) four',
    question: '',
    correct_answer: 'C',
  };
  const parsed = parseQuestion(salvageQuestionFields(raw).question);
  assert.equal(parsed.stem, 'Which choice most effectively completes the text?');
  assert.deepEqual(
    [parsed.choiceA, parsed.choiceB, parsed.choiceC, parsed.choiceD],
    ['one', 'two', 'three', 'four'],
  );
});
