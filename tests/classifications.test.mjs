// Lining the classifier's three columns up with the rows they describe.
//
// The classifications used to be appended as one contiguous block, starting at
// whatever row column K ran out on. That held only while every row was filled, in
// order, with something non-empty. Two things break it:
//
//   * a question that failed to transcribe leaves its row empty and was skipped
//     without a placeholder, so every classification below it moved up a row;
//   * math rows are deliberately blank now — they were filled with 'N/A' purely
//     so that counting non-empty cells still found the right place to start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignClassifications } from '../lib/pipeline.js';

const rw = (row, n) => ({
  row, passageType: `p${n}`, questionType: `q${n}`, difficultyLevel: `d${n}`,
});
const math = (row) => ({ row, passageType: '', questionType: '', difficultyLevel: '' });

test('a full run of rows writes one block from the first row', () => {
  const { startRow, values } = alignClassifications([rw(2, 1), rw(3, 2), rw(4, 3)]);

  assert.equal(startRow, 2);
  assert.deepEqual(values, [['p1', 'q1', 'd1'], ['p2', 'q2', 'd2'], ['p3', 'q3', 'd3']]);
});

test('a gap stays a gap instead of pulling the rest up', () => {
  // Row 3 lost its question. Row 4's classification must stay on row 4.
  const { startRow, values } = alignClassifications([rw(2, 1), rw(4, 3)]);

  assert.equal(startRow, 2);
  assert.equal(values.length, 3, 'rows 2, 3 and 4');
  assert.deepEqual(values[1], ['', '', ''], 'row 3 is blank');
  assert.deepEqual(values[2], ['p3', 'q3', 'd3'], 'row 4 keeps its own classification');
});

test('math rows are written blank rather than skipped', () => {
  // Skipping them would put math's blank row under a Reading and Writing question.
  const { startRow, values } = alignClassifications([rw(54, 1), rw(55, 2), math(56), math(57)]);

  assert.equal(startRow, 54);
  assert.deepEqual(values, [['p1', 'q1', 'd1'], ['p2', 'q2', 'd2'], ['', '', ''], ['', '', '']]);
});

test('several gaps in a row all hold their place', () => {
  const { values } = alignClassifications([rw(2, 1), rw(7, 6)]);

  assert.equal(values.length, 6);
  assert.deepEqual(values.slice(1, 5), [['', '', ''], ['', '', ''], ['', '', ''], ['', '', '']]);
  assert.deepEqual(values[5], ['p6', 'q6', 'd6']);
});

test('a run that starts partway down the sheet reports where it starts', () => {
  const { startRow, values } = alignClassifications([rw(56, 1), rw(57, 2)]);

  assert.equal(startRow, 56);
  assert.equal(values.length, 2);
});

test('nothing to write is reported as nothing, not as row 1', () => {
  assert.deepEqual(alignClassifications([]), { startRow: 2, values: [] });
  assert.deepEqual(alignClassifications(), { startRow: 2, values: [] });
});

test('entries without a usable row are dropped rather than guessed at', () => {
  const { startRow, values } = alignClassifications([
    { passageType: 'p', questionType: 'q', difficultyLevel: 'd' }, // no row
    { row: 1, passageType: 'header', questionType: 'x', difficultyLevel: 'y' }, // the header
    rw(2, 1),
  ]);

  assert.equal(startRow, 2);
  assert.deepEqual(values, [['p1', 'q1', 'd1']]);
});

test('an errored row still occupies its own slot', () => {
  const errored = { row: 3, passageType: 'Error', questionType: 'Error', difficultyLevel: 'Error' };
  const { values } = alignClassifications([rw(2, 1), errored, rw(4, 3)]);

  assert.deepEqual(values[1], ['Error', 'Error', 'Error']);
  assert.deepEqual(values[2], ['p3', 'q3', 'd3']);
});

test('the whole 98 row template lines up end to end', () => {
  const results = [];
  for (let row = 2; row <= 55; row += 1) results.push(rw(row, row));
  for (let row = 56; row <= 99; row += 1) results.push(math(row));

  const { startRow, values } = alignClassifications(results);

  assert.equal(startRow, 2);
  assert.equal(values.length, 98);
  assert.deepEqual(values[53], ['p55', 'q55', 'd55'], 'row 55 is the last classified one');
  assert.deepEqual(values[54], ['', '', ''], 'row 56 is the first math row');
});
