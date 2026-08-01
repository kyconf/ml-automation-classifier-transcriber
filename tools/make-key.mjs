#!/usr/bin/env node
// Turn an export into a starting point for an answer key.
//
//   npm run make-key -- export.xlsx fixtures/202603usv1.json
//   npm run make-key -- export.xlsx fixtures/rw-module-1.json --rows 2-28
//
// This does NOT produce a verified key — it produces a draft with the pipeline's
// own output in it, which you then correct against the PDF. That is far less work
// than typing 98 questions, but it means an unchecked key would simply certify
// whatever the pipeline already did. Every question starts with "verified": false
// and the scorer's key should only keep the ones you have actually looked at.
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const COL = { section: 2, passage: 3, content: 4, choiceA: 5, answer: 9 };

const args = process.argv.slice(2);
const [sheetPath, outPath] = args.filter((a) => !a.startsWith('--'));
const rowsArg = args.includes('--rows') ? args[args.indexOf('--rows') + 1] : '2-99';

if (!sheetPath || !outPath) {
  console.error('usage: npm run make-key -- <export.xlsx> <out.json> [--rows 2-28]');
  process.exit(2);
}

const [firstRow, lastRow] = rowsArg.split('-').map(Number);

const workbook = XLSX.readFile(sheetPath);
const sheetName = workbook.SheetNames[workbook.SheetNames.length - 1];
const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
  header: 1, raw: false, defval: '',
});

const questions = [];
grid.forEach((cells, index) => {
  const row = index + 1;
  if (row < firstRow || row > lastRow) return;
  const content = String(cells[COL.content] || '').trim();
  if (!content) return; // an empty row is a gap; there is nothing to verify yet

  questions.push({
    row,
    verified: false,
    section: cells[COL.section] || '',
    content,
    choices: [0, 1, 2, 3].map((n) => cells[COL.choiceA + n] || ''),
    answer: cells[COL.answer] || '',
  });
});

const key = {
  pdf: path.basename(sheetPath).replace(/\.xlsx$/i, '.pdf'),
  note: 'DRAFT. Each question is the pipeline\'s own output — check it against the '
    + 'PDF and set "verified": true. Delete anything you have not checked; the '
    + 'scorer ignores rows the key does not mention, so a small verified key is '
    + 'worth more than a large unchecked one.',
  questions,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(key, null, 2)}\n`);

console.log(`Wrote ${questions.length} draft question(s) from "${sheetName}" to ${outPath}`);
console.log(`Rows ${firstRow}-${lastRow}. Every entry is marked "verified": false.`);
console.log('\nNext: open it beside the PDF, fix what is wrong, and delete what you have not checked.');
