// The two ways a cell is silently corrupted by the importer's formatter.
//
// That formatter turns markers into rich text: **bold**, *italic*, {underline}.
// It reads { } as an underline marker everywhere EXCEPT inside math delimiters,
// and it pairs $ left to right across the whole cell. So undelimited LaTeX loses
// its braces — \frac{9}{100} becomes \frac9100, rendering as 9/1 and a stray 00
// — and a single unpaired $ mis-pairs every delimiter after it. Neither failure
// shows up in the cell that caused it, and a bad cell rejects the whole sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFormatting } from '../lib/pipeline.js';

const problems = (text) => checkFormatting(text);
const clean = (text) => assert.deepEqual(problems(text), [], `should be clean: ${text}`);
const flags = (text, pattern) => {
  const found = problems(text);
  assert.ok(found.length, `should have flagged: ${text}`);
  assert.match(found.join(' | '), pattern);
};

test('correctly delimited math passes', () => {
  clean('The expression $\\frac{9}{100}$ is equivalent to $0.09$.');
  clean('What is the x-intercept of a line with slope $-\\frac{4}{7}$?');
  clean('$\\frac{6x^{2}}{4}$ is equivalent to $\\frac{3x^{2}}{2}$.');
  clean('\\[ \\begin{array}{c|c} a & b \\end{array} \\]');
  clean('Consider \\( x^{2} + 1 \\) and nothing else.');
});

test('prose with emphasis markers passes', () => {
  clean('The **primary** purpose of the passage');
  clean('the novel *Beloved* explores');
  clean('Which choice best states the {main idea}?');
  clean('%GRAPH% In the right triangle shown, what is the value of $\\cos A$?');
});

test('undelimited LaTeX is caught', () => {
  flags('The expression \\frac{9}{100} is equivalent to 0.09.', /outside math delimiters/);
  flags('A circle has radius \\sqrt{85} centimetres.', /outside math delimiters/);
});

test('an unpaired dollar sign is caught', () => {
  flags('A shirt costs $12.50 before tax.', /unbalanced math delimiters/);
  flags('The value of $x is unknown.', /unbalanced/);
});

test('currency written the accepted ways passes', () => {
  clean('A shirt costs $\\$12.50$ before tax.');
  clean('A shirt costs 12.50 dollars before tax.');
});

test('an escaped dollar does not open a span', () => {
  // \$ is a literal dollar. Counting it as a delimiter would flag every correct
  // currency amount and bury the real problems.
  clean('Prices are $\\$5$ and $\\$7$.');
  // An escaped dollar outside math is still balanced — only the bare one is not.
  clean('Prices are $\\$5$ and \\$7 respectively.');
  flags('Prices are $\\$5$ and $7 respectively.', /unbalanced/);
});

test('an emphasis marker inside math is caught', () => {
  flags('$x = **2**$', /emphasis marker inside a math expression/);
});

test('emphasis outside math, adjacent to it, is fine', () => {
  clean('**the value of** $x$');
  clean('*See* $\\frac{1}{2}$ for details.');
});

test('an empty or missing cell has nothing to check', () => {
  assert.deepEqual(problems(''), []);
  assert.deepEqual(problems('   '), []);
  assert.deepEqual(problems(null), []);
  assert.deepEqual(problems(undefined), []);
});

test('plain prose with no math at all passes', () => {
  clean('Which choice completes the text with the most logical transition?');
  clean('A) Likewise,');
});

test('a real corrupted row from an export is caught', () => {
  // The bacillus question, transcribed with the fraction left bare.
  flags(
    'Which function f best represents the number of cells? A) f(x)=980\\left(\\frac{1}{2}\\right)^{x}',
    /outside math delimiters/,
  );
});

test('several problems in one cell are all reported', () => {
  const found = problems('Cost is $12.50 and the ratio is \\frac{1}{2}.');
  assert.equal(found.length, 2);
});
