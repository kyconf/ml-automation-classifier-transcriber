// Transcription parsing: the shapes the model returns, and how a question blob
// is split into stem and choices. Every case here comes from a response that
// actually broke a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuestion,
  parseTranscriptionResponse,
  unwrapQuestions,
  cleanJsonResponse,
} from '../lib/pipeline.js';

test('schema envelope yields the questions array', () => {
  const raw = JSON.stringify({
    questions: [
      { section: 'Reading and Writing', passage: 'p', question: 'Q1?', correct_answer: 'A' },
      { section: 'Math', passage: '', question: 'Solve $x^2$', correct_answer: '4' },
    ],
  });
  const out = parseTranscriptionResponse(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((q) => q.correct_answer), ['A', '4']);
});

// Before the strict schema the model returned these three shapes interchangeably.
// Two of them dropped an entire page of questions; the third wrote one blank row.
test('recovers bare objects returned back to back', () => {
  const raw = '```json\n{"correct_answer":"A"}\n{"correct_answer":"B"}\n```';
  assert.equal(parseTranscriptionResponse(raw).length, 2);
});

test('recovers a bare array', () => {
  assert.equal(parseTranscriptionResponse('[{"correct_answer":"A"},{"correct_answer":"B"}]').length, 2);
});

test('recovers several fenced blocks', () => {
  const raw = '```json\n{"correct_answer":"A"}\n```\n\n```json\n{"correct_answer":"B"}\n```';
  assert.equal(parseTranscriptionResponse(raw).length, 2);
});

test('a truncated tail does not discard the questions before it', () => {
  assert.equal(parseTranscriptionResponse('{"a":1}\n{"b":').length, 1);
});

test('braces inside strings do not fool the scanner', () => {
  // {good} is underline markup and \frac{3}{4} is LaTeX; both live inside strings.
  const raw = '{"passage":"of a {good} height","correct_answer":"C"}\n'
    + '{"passage":"","question":"Solve $\\\\frac{3}{4}x = 9$","correct_answer":"12"}';
  const out = parseTranscriptionResponse(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].passage, 'of a {good} height');
  assert.equal(out[1].correct_answer, '12');
});

test('empty response throws rather than returning nothing usable', () => {
  assert.throws(() => parseTranscriptionResponse('no json here at all'));
});

test('unwrapQuestions handles all three containers', () => {
  assert.deepEqual(unwrapQuestions([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(unwrapQuestions({ questions: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(unwrapQuestions({ a: 1 }), [{ a: 1 }]);
});

test('cleanJsonResponse strips code fences', () => {
  assert.equal(cleanJsonResponse('```json\n{"a":1}\n```'), '{"a":1}');
});

test('splits a stem from its four choices', () => {
  const blob = 'Which choice completes the text?\n\nA) persists\nB) responds\nC) arrives\nD) agrees\n\n';
  assert.deepEqual(parseQuestion(blob), {
    stem: 'Which choice completes the text?',
    choiceA: 'persists',
    choiceB: 'responds',
    choiceC: 'arrives',
    choiceD: 'agrees',
  });
});

test('student-produced response keeps its stem and has no choices', () => {
  const blob = 'If $3x + 7 = 22$, what is the value of $x$?';
  const out = parseQuestion(blob);
  assert.equal(out.stem, blob);
  assert.deepEqual([out.choiceA, out.choiceB, out.choiceC, out.choiceD], ['', '', '', '']);
});

test('LaTeX in choices survives the split', () => {
  const blob = 'What is the solution to $\\frac{x}{2} = 8$?\n\n'
    + 'A) $x = \\frac{1}{4}$\nB) $x = 4$\nC) $x = 16$\nD) $x = \\sqrt{64}$\n\n';
  const out = parseQuestion(blob);
  assert.equal(out.choiceA, '$x = \\frac{1}{4}$');
  assert.equal(out.choiceD, '$x = \\sqrt{64}$');
});

test('an undefined question blob does not throw', () => {
  assert.deepEqual(parseQuestion(undefined), {
    stem: '', choiceA: '', choiceB: '', choiceC: '', choiceD: '',
  });
});
