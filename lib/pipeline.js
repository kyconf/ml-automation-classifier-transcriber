// Pure pipeline logic — no network, no filesystem, no Google clients.
// Split out from server.js so the parts that decide what lands in which row can
// be tested directly; everything here is a plain function of its arguments.

import path from 'path';

export const CHOICE_GRAPH_MARKER = '%CHOICES_GRAPH%';
export const CHOICE_IMAGE_LABEL = 'CHOICE_IMAGE';

// Both Reading and Writing modules hold 27 questions each and land in rows 2-55,
// so math cannot begin before this row.
// The sheet template pre-creates a fixed block of rows per exam, matching the
// digital SAT: 27 questions in each of the two Reading and Writing modules, then
// 22 in each of the two math modules — 98 in all. Those slots are what the
// module/number columns are numbered against, so questions must land in them
// rather than simply following on from whatever was written last.
export const RW_QUESTION_COUNT = 27 * 2;   // 54, rows 2-55
export const MATH_QUESTION_COUNT = 22 * 2; // 44, rows 56-99
export const FIRST_MATH_ROW = 2 + RW_QUESTION_COUNT;                       // 56
export const LAST_QUESTION_ROW = FIRST_MATH_ROW + MATH_QUESTION_COUNT - 1; // 99
export const QUESTION_CAPACITY = RW_QUESTION_COUNT + MATH_QUESTION_COUNT;  // 98

// The section a question belongs to is decided by its position in the exam, not
// by the transcriber's guess: a Reading and Writing question built around a
// graph or a data table often gets called "Math" from the look of the page.
//
// The template fixes which rows belong to which section: 2-55 are the two
// Reading and Writing modules, 56-99 the two math modules. So the row settles the
// label, and Reading and Writing cannot exceed 54 questions however the page was
// read. The page signals still decide *where* a page is written — see
// planPageWrite — but once a question has a row, its section follows from it.
export function sectionFor(sheetRow) {
  return sheetRow >= FIRST_MATH_ROW ? 'Math' : 'Reading and Writing';
}

// Crossing into the math block is destructive — it skips the rest of the Reading
// and Writing slots — so it takes two independent signals agreeing: the page sits
// at or beyond where the structure pass placed the math modules, AND the
// transcriber read most of the questions on the page as math. Either alone has
// been wrong: the structure pass can name the last Reading and Writing page, and
// the transcriber calls a graph-heavy Reading and Writing question "Math".
export function pageIsMath(questions, pageNumber, mathStartPage) {
  if (!mathStartPage || pageNumber < mathStartPage) return false;

  const labelledMath = questions.filter(q => /^\s*math/i.test(q.section || '')).length;
  const agrees = labelledMath * 2 >= questions.length;

  if (!agrees) {
    console.warn(`⚠️ page-${pageNumber}: the structure pass placed this at or past the math start (page ${mathStartPage}) but ${questions.length - labelledMath}/${questions.length} question(s) read as Reading and Writing — keeping it in Reading and Writing.`);
  }
  return agrees;
}


// Parse question blob into stem + individual choices
export function parseQuestion(questionString) {
  const empty = { stem: '', choiceA: '', choiceB: '', choiceC: '', choiceD: '' };
  if (!questionString) return empty;

  // Choices do not always start at A. When a question is split by a page break
  // the page can begin partway down the list, so the split is made at whichever
  // marker appears first rather than assuming "A)".
  const firstMarker = questionString.search(/\n\s*\n?\s*[A-D]\)/);
  const stem = firstMarker !== -1 ? questionString.slice(0, firstMarker).trim() : questionString.trim();
  const choicesPart = firstMarker !== -1 ? questionString.slice(firstMarker) : '';

  // Each choice runs until the next marker or the end of the block.
  const grab = (letter, next) => {
    const pattern = next
      ? new RegExp(`${letter}\\)(.*?)(?=\\n\\s*${next}\\))`, 's')
      : new RegExp(`${letter}\\)(.*?)(?=\\n\\s*\\n|$)`, 's');
    const found = choicesPart.match(pattern);
    return found ? found[1].trim() : '';
  };

  // The terminator for a choice is the next marker that is actually present.
  const present = ['A', 'B', 'C', 'D'].filter((l) => new RegExp(`\\n\\s*${l}\\)`).test('\n' + choicesPart));
  const nextOf = (letter) => present[present.indexOf(letter) + 1] || null;

  return {
    stem,
    choiceA: present.includes('A') ? grab('A', nextOf('A')) : '',
    choiceB: present.includes('B') ? grab('B', nextOf('B')) : '',
    choiceC: present.includes('C') ? grab('C', nextOf('C')) : '',
    choiceD: present.includes('D') ? grab('D', nextOf('D')) : '',
  };
}

// The model often puts the whole question into "passage" and leaves "question"
// empty, which lands a blank content cell and no choices in the sheet. When that
// happens the passage is split at its prompt sentence: the prompt and anything
// after it become the question, and what came before stays the passage.
export function salvageQuestionFields(q) {
  const question = String(q.question || '').trim();
  const passage = String(q.passage || '').trim();
  if (question || !passage) return q;

  // The prompt is the last sentence that asks something.
  const prompts = [...passage.matchAll(/(^|[.?!]\s+|\n)([A-Z][^.?!\n]*\?)/g)];
  if (!prompts.length) return { ...q, question: passage, passage: '' };

  const last = prompts[prompts.length - 1];
  const start = last.index + last[1].length;

  return { ...q, question: passage.slice(start).trim(), passage: passage.slice(0, start).trim() };
}


// Add this helper function at the top
export function cleanJsonResponse(response) {
  // Remove markdown code blocks and clean the response
  return response.replace(/```json\s*|\s*```/g, '').trim();
}

// Unwrap the schema's { questions: [...] } envelope.
export function unwrapQuestions(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.questions)) return value.questions;
  return [value];
}

// With a strict schema the response is guaranteed to parse, so the first branch
// is the normal path. The rest is a safety net for responses produced without
// the schema: a page holds several questions and an unconstrained model returns
// them inconsistently — a JSON array, bare objects back to back, or several
// separate ```json blocks. Always hand back a flat array of question objects.
export function parseTranscriptionResponse(raw) {
  const cleaned = cleanJsonResponse(raw);

  try {
    return unwrapQuestions(JSON.parse(cleaned));
  } catch (err) {
    // Not a single JSON value — fall through and pull the values out one by one.
  }

  const items = [];
  let depth = 0, start = -1, inString = false, escaped = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }

    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (depth === 0) continue; // stray closer, ignore
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          items.push(...unwrapQuestions(JSON.parse(cleaned.slice(start, i + 1))));
        } catch (err) {
          console.error('⚠️ Skipping unparseable JSON block:', err.message);
        }
        start = -1;
      }
    }
  }

  if (items.length === 0) throw new Error('No valid JSON objects found in transcription response');
  return items;
}


export function pageNumberFromImage(imagePath) {
  const match = path.basename(imagePath).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// Questions whose answer choices are pictures are marked in the choice columns
// rather than transcribed, since there is no choice text to capture.
export function questionHasChoiceGraphs(q) {
  // The model puts the marker in whichever field it considers the question, so
  // both are checked.
  return `${q.question || ''} ${q.passage || ''}`.includes(CHOICE_GRAPH_MARKER);
}


// Run an async job over a list with a ceiling on how many are in flight, keeping
// results in input order however they finish.
export async function mapWithConcurrency(items, limit, job) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await job(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}


// Compare what the run produced against what the structure pass expected. This
// only reports; nothing here changes a single cell. The point is that a short or
// misread exam announces itself instead of quietly becoming a short sheet.
export function reportRunHealth(transcribed, responses, expected, sheetName) {
  const written = responses.reduce((n, r) => n + (r.response ? r.response.length : 0), 0);
  const problems = [];

  const failed = responses.filter(r => r.error);
  if (failed.length) problems.push(`${failed.length} page(s) failed: ${failed.map(r => path.basename(r.image)).join(', ')}`);

  const skipped = responses.filter(r => r.skipped);
  if (skipped.length) problems.push(`${skipped.length} page(s) skipped once the sheet was full`);

  if (expected?.totalQuestions && written < expected.totalQuestions) {
    problems.push(`expected about ${expected.totalQuestions} question(s) but wrote ${written}`);
  }

  if (expected?.questionsPerPage) {
    const odd = transcribed
      .filter(p => p.questions && p.questions.length !== expected.questionsPerPage)
      .map(p => `${path.basename(p.image)}:${p.questions.length}`);
    if (odd.length) {
      problems.push(`${odd.length} page(s) did not hold the usual ${expected.questionsPerPage} question(s) — ${odd.slice(0, 8).join(', ')}${odd.length > 8 ? ', …' : ''}`);
    }
  }

  if (!problems.length) {
    console.log(`✅ "${sheetName}": ${written} question(s) written, nothing looks off.`);
    return;
  }

  console.warn(`\n⚠️ "${sheetName}" finished with things worth checking:`);
  for (const problem of problems) console.warn(`   • ${problem}`);
  console.warn('');
}


// Decide where a page's questions go, or that they do not go at all.
//
// The sheet is two fixed blocks — Reading and Writing in rows 2-55, math in
// 56-99 — and both have to be defended from the other. Reading and Writing
// coming up short must not let math drift up into the empty slots, and Reading
// and Writing running long must not push math down and off the end. Every
// decision is returned rather than acted on, so this stays a pure function.
export function planPageWrite({ questions, pageNumber, nextRow, mathStartPage }) {
  const isMathPage = pageIsMath(questions, pageNumber, mathStartPage);
  const notes = [];
  let startRow = nextRow;

  // Math begins in its own block even if Reading and Writing left gaps.
  if (isMathPage && startRow < FIRST_MATH_ROW) {
    notes.push(`⚠️ Reading and Writing filled only ${startRow - 2} of ${RW_QUESTION_COUNT} slots; leaving rows ${startRow}-${FIRST_MATH_ROW - 1} blank so math starts in its own block.`);
    startRow = FIRST_MATH_ROW;
  }

  // Reading and Writing may not spend math's slots. Restricted to pages the
  // structure pass puts before the math modules, so a math page the transcriber
  // misread as Reading and Writing is still written rather than thrown away.
  const beforeMathModules = Boolean(mathStartPage) && pageNumber < mathStartPage;
  if (!isMathPage && beforeMathModules && startRow >= FIRST_MATH_ROW) {
    notes.push(`⚠️ Reading and Writing has already filled its ${RW_QUESTION_COUNT} slots; dropping ${questions.length} further question(s) rather than pushing math out of its block.`);
    for (const q of questions) notes.push(`     dropped: ${String(q.question || '').slice(0, 70)}`);
    return { action: 'skip', reason: `Reading and Writing overran ${RW_QUESTION_COUNT} questions`, isMathPage, notes };
  }

  if (startRow > LAST_QUESTION_ROW) {
    notes.push(`⏹️  Row ${LAST_QUESTION_ROW} is full — stopping.`);
    return { action: 'stop', reason: `past row ${LAST_QUESTION_ROW}`, isMathPage, notes };
  }

  const roomLeft = LAST_QUESTION_ROW - startRow + 1;
  let write = questions;
  if (questions.length > roomLeft) {
    notes.push(`⏹️  Page holds ${questions.length} question(s) but only ${roomLeft} slot(s) remain before row ${LAST_QUESTION_ROW}; writing ${roomLeft} and dropping the rest.`);
    write = questions.slice(0, roomLeft);
  }

  return {
    action: 'write',
    startRow,
    isMathPage,
    questions: write,
    dropped: questions.length - write.length,
    notes,
  };
}

// Stitch page-break splits back into one question.
//
// A question whose choices fall on the next page used to become two rows: the
// page it starts on gives the passage and stem, the next page gives the orphaned
// choices, which the model then dressed up as a fresh question. Four such splits
// in one exam pushed Reading and Writing to 58 questions and shoved math out of
// its block. Continuation entries are folded into the question they belong to
// before anything is counted or written.
// An orphaned block of answer choices, recognised by shape rather than by the
// model admitting to it. A real question always opens with its prompt; text that
// opens directly with "A)" or "C)" is the tail of the question before it. The
// model marks continues_previous_page only sometimes, and in the math section
// hardly ever, so this catches the rest.
export function isOrphanChoiceBlock(q) {
  const text = String(q.question || q.passage || '').trim();
  if (!text) return false;
  if (!/^[A-D]\)/.test(text)) return false;
  // Two or more markers: a single "A) ..." line could be a genuine short answer.
  return (text.match(/(?:^|\s)[A-D]\)/g) || []).length >= 2;
}

export function mergePageContinuations(pages) {
  let merged = 0;
  const out = pages.map((page) => ({ ...page }));
  let lastQuestion = null;

  for (const page of out) {
    if (!page.questions) continue; // a page that failed to transcribe
    const kept = [];

    for (const q of page.questions) {
      if ((q.continues_previous_page || isOrphanChoiceBlock(q)) && lastQuestion) {
        // The tail carries the real choices; the head may have invented some.
        const tail = String(q.question || q.passage || '').trim();
        if (tail) {
          const head = String(lastQuestion.question || '').replace(/\n\nA\)[\s\S]*$/, '').trim();
          lastQuestion.question = `${head}\n\n${tail}`;
        }
        if (q.correct_answer) lastQuestion.correct_answer = q.correct_answer;
        merged += 1;
        continue;
      }
      kept.push(q);
      lastQuestion = q;
    }

    page.questions = kept;
  }

  if (merged) {
    console.log(`🔗 Rejoined ${merged} question(s) split across a page break.`);
  }
  return out;
}

// Recover the answer letter from whatever the model returned.
//
// The prompt asks for a bare letter, but in practice the answer comes back as
// the choice's text ("26/49"), the text with its letter ("B) Ultimately,"), or a
// LaTeX expression. Since the choices are already parsed, the letter can be
// worked out instead of trusted. A question with no choices is a student-produced
// response, where the value itself is the answer and is left alone.
const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];

function normaliseForCompare(value) {
  return String(value ?? '')
    .replace(/\$/g, '')       // LaTeX delimiters carry no meaning
    .replace(/\\/g, '')       // \cos becomes cos, keeping the command word:
                              // stripping the whole command made "cos L > sin K"
                              // and "cos L = sin K" identical, and the answer was
                              // then confidently assigned to the wrong choice
    .replace(/[\s,]+/g, ' ')
    .replace(/[^\w\s./()^+\-<>=]/g, '') // keep relational operators
    .trim()
    .toLowerCase();
}

export function normaliseAnswer(rawAnswer, choices = []) {
  const answer = String(rawAnswer ?? '').trim();
  if (!answer) return { answer: '', matched: false };

  const hasChoices = choices.some((c) => String(c ?? '').trim());
  if (!hasChoices) return { answer, matched: true }; // student-produced response

  if (/^[A-D]$/i.test(answer)) return { answer: answer.toUpperCase(), matched: true };

  // "B) text", "B. text", "B - text"
  const prefixed = answer.match(/^([A-D])\s*[).:\-–]/i);
  if (prefixed) return { answer: prefixed[1].toUpperCase(), matched: true };

  const target = normaliseForCompare(answer);
  if (target) {
    // A match only counts when exactly one choice matches. Two choices that
    // normalise the same way mean the comparison has lost the distinction.
    const exact = choices
      .map((c, i) => (normaliseForCompare(c) === target ? i : -1))
      .filter((i) => i !== -1);
    if (exact.length === 1) return { answer: CHOICE_LETTERS[exact[0]], matched: true };
    if (exact.length > 1) return { answer, matched: false };

    const contained = choices
      .map((c, i) => (normaliseForCompare(c) && normaliseForCompare(c).includes(target) ? i : -1))
      .filter((i) => i !== -1);
    if (contained.length === 1) return { answer: CHOICE_LETTERS[contained[0]], matched: true };
  }

  // Nothing lined up — hand it back untouched so the caller can say so.
  return { answer, matched: false };
}
