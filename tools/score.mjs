#!/usr/bin/env node
// Score an exported sheet against a known-correct answer key.
//
//   npm run score -- fixtures/202603usv1.json export.xlsx
//   npm run score -- fixtures/202603usv1.json export.xlsx --diff
//
// The point is to replace "does this look better?" with a number. A change to the
// pipeline can then be checked in seconds, against the same exam, without an API
// call — which is how a change that made three exams worse got shipped before
// this existed.
//
// The key is JSON and only needs the questions you have actually verified; rows
// it does not mention are ignored, so a partial key covering one module is
// immediately useful.
//
//   {
//     "pdf": "202603usv1.pdf",
//     "questions": [
//       {
//         "row": 2,
//         "section": "Reading and Writing",
//         "content": "Which choice completes the text...?",
//         "choices": ["persists", "responds", "arrives", "agrees"],
//         "answer": "A"
//       }
//     ]
//   }
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

// Columns in the sheet: C=section D=passage E=content F..I=choices J=answer
const COL = { section: 2, passage: 3, content: 4, choiceA: 5, answer: 9 };

// Comparison ignores differences that do not matter to a reader: surrounding
// whitespace, straight versus curly quotes, and LaTeX delimiters.
function normalise(value) {
  return String(value ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const same = (a, b) => normalise(a) === normalise(b);

function readSheet(file) {
  const workbook = XLSX.readFile(file);
  const sheet = workbook.Sheets[workbook.SheetNames[workbook.SheetNames.length - 1]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const rows = new Map();
  grid.forEach((cells, index) => {
    const rowNumber = index + 1;
    if (rowNumber < 2) return;
    rows.set(rowNumber, {
      section: cells[COL.section] || '',
      passage: cells[COL.passage] || '',
      content: cells[COL.content] || '',
      choices: [0, 1, 2, 3].map((n) => cells[COL.choiceA + n] || ''),
      answer: cells[COL.answer] || '',
    });
  });
  return { name: workbook.SheetNames[workbook.SheetNames.length - 1], rows };
}

function score(key, sheet) {
  const result = {
    expected: key.questions.length,
    found: 0, missing: [], exact: 0,
    fields: { section: 0, content: 0, answer: 0 },
    // How many keys actually asserted each field. A field the key stays silent on
    // scored 0/95 and read as a total failure, when it only meant "not checked".
    asserted: { section: 0, content: 0, answer: 0 },
    choices: { correct: 0, total: 0 },
    problems: [],
  };

  for (const want of key.questions) {
    const got = sheet.rows.get(want.row);
    const empty = !got || !String(got.content).trim();

    if (empty) {
      result.missing.push(want.row);
      result.problems.push({ row: want.row, field: 'row', want: want.content, got: '(empty)' });
      continue;
    }
    result.found += 1;

    let perfect = true;
    for (const field of ['section', 'content', 'answer']) {
      if (want[field] === undefined) continue;
      result.asserted[field] += 1;
      if (same(want[field], got[field])) result.fields[field] += 1;
      else {
        perfect = false;
        result.problems.push({ row: want.row, field, want: want[field], got: got[field] });
      }
    }

    (want.choices || []).forEach((wantChoice, i) => {
      result.choices.total += 1;
      if (same(wantChoice, got.choices[i])) result.choices.correct += 1;
      else {
        perfect = false;
        result.problems.push({
          row: want.row, field: `choice ${'ABCD'[i]}`, want: wantChoice, got: got.choices[i],
        });
      }
    });

    if (perfect) result.exact += 1;
  }
  return result;
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : '—';
}

function report(key, sheet, result, showDiff) {
  const line = (label, n, d) => console.log(`  ${label.padEnd(22)}${String(n).padStart(4)}/${String(d).padEnd(5)} ${pct(n, d).padStart(6)}`);

  console.log(`\n${key.pdf || 'exam'}  →  sheet "${sheet.name}"`);
  console.log('─'.repeat(50));
  line('questions present', result.found, result.expected);
  line('perfect rows', result.exact, result.expected);
  console.log('');
  for (const field of ['section', 'content', 'answer']) {
    if (result.asserted[field]) line(field, result.fields[field], result.asserted[field]);
    else console.log(`  ${field.padEnd(22)}   not checked by this key`);
  }
  if (result.choices.total) line('choices', result.choices.correct, result.choices.total);
  else console.log(`  ${'choices'.padEnd(22)}   not checked by this key`);

  if (result.missing.length) {
    console.log(`\n  missing rows: ${result.missing.join(', ')}`);
  }

  if (showDiff && result.problems.length) {
    console.log(`\n  ${result.problems.length} difference(s):`);
    for (const p of result.problems.slice(0, 40)) {
      console.log(`    row ${String(p.row).padStart(3)} ${p.field}`);
      console.log(`        want: ${JSON.stringify(String(p.want).slice(0, 70))}`);
      console.log(`        got : ${JSON.stringify(String(p.got).slice(0, 70))}`);
    }
    if (result.problems.length > 40) console.log(`    …and ${result.problems.length - 40} more`);
  } else if (result.problems.length) {
    console.log(`\n  ${result.problems.length} difference(s). Re-run with --diff to see them.`);
  }

  const grade = result.expected ? result.exact / result.expected : 0;
  console.log(`\n  SCORE ${(grade * 100).toFixed(1)}%  (${result.exact}/${result.expected} questions exactly right)\n`);
  return grade;
}

const [keyPath, sheetPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const showDiff = process.argv.includes('--diff');

if (!keyPath || !sheetPath) {
  console.error('usage: npm run score -- <answer-key.json> <export.xlsx> [--diff]');
  process.exit(2);
}
for (const file of [keyPath, sheetPath]) {
  if (!fs.existsSync(file)) {
    console.error(`not found: ${file}`);
    process.exit(2);
  }
}

const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
if (!Array.isArray(key.questions) || !key.questions.length) {
  console.error(`${path.basename(keyPath)} has no "questions" array.`);
  process.exit(2);
}

const sheet = readSheet(sheetPath);
const result = score(key, sheet);
report(key, sheet, result, showDiff);

// Non-zero exit unless every verified question matched, so a change can be gated
// on the score rather than on someone remembering to look at it.
process.exit(result.exact === result.expected ? 0 : 1);
