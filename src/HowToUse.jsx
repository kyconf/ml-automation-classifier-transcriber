import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText, FileImage, CheckSquare, Table2, KeyRound, ScrollText,
  Check, X, ArrowRight, Scissors,
} from 'lucide-react';
import { Page, Card, Note, AnswerKeyNote } from './components/Layout';

function Section({ icon: Icon, title, children }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600/15 text-indigo-300">
          <Icon size={15} />
        </div>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <div className="space-y-3 pl-[38px] text-sm leading-relaxed text-slate-400">{children}</div>
    </section>
  );
}

// A do / don't pair. The batching rule is the one that silently produces a wrong
// sheet rather than an error, so it gets shown rather than described.
function Example({ ok, title, items }) {
  const Icon = ok ? Check : X;
  return (
    <div
      className={`flex-1 rounded-lg border p-3 ${
        ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-rose-500/25 bg-rose-500/5'
      }`}
    >
      <div className={`mb-2 flex items-center gap-1.5 text-xs font-semibold ${ok ? 'text-emerald-300' : 'text-rose-300'}`}>
        <Icon size={13} />
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="font-mono text-[11px] leading-relaxed text-slate-400">{item}</li>
        ))}
      </ul>
    </div>
  );
}

const ROW_MAP = [
  ['Reading and Writing', 'Module 1', '27', '2 – 28'],
  ['Reading and Writing', 'Module 2', '27', '29 – 55'],
  ['Math', 'Module 1', '22', '56 – 77'],
  ['Math', 'Module 2', '22', '78 – 99'],
];

function HowToUse() {
  const navigate = useNavigate();

  return (
    <Page title="How to use" subtitle="What to feed the transcriber, and what it does with it.">
      <div className="mx-auto max-w-2xl">
        <Card>
          <Section icon={FileText} title="What to upload">
            <p>
              One PDF per exam on the <button onClick={() => navigate('/pdf')} className="text-indigo-300 hover:underline">PDF</button> tab,
              or a set of question screenshots on the <button onClick={() => navigate('/image')} className="text-indigo-300 hover:underline">Image</button> tab.
              Each exam becomes its own sheet.
            </p>
            <p>
              Any page layout works — one question per page, two per page, or a full printed page of
              them. What matters is that the question numbers are visible, since that is what decides
              which row each question lands in.
            </p>
            <p className="text-slate-500">
              Images are read in filename order, so name them <span className="font-mono text-slate-400">01.png</span>,{' '}
              <span className="font-mono text-slate-400">02.png</span>, and so on.
            </p>

            <Note tone="warning" icon={Scissors} title="Pages that are not questions cost accuracy">
              A file of nothing but question pages is read most accurately. Title pages, instruction
              and cover pages, an answer key at the end, and any other page that is not an SAT
              question all make the read worse — they are extra pages to be identified and set aside,
              and each one is a chance to get that wrong. They are handled, not ignored, but if you
              can strip them out before uploading, do.
            </Note>
          </Section>

          <Section icon={CheckSquare} title="Tick the modules before you drop">
            <p>
              The two checkboxes tell the transcriber which part of the exam it is looking at. This
              cannot be worked out reliably from the file itself: a Math-only exam starts numbering at
              question 1 with nothing in front of it, so it looks exactly like a Reading and Writing
              exam, and every question ends up in the wrong half of the sheet.
            </p>
            <p>Leave both ticked for a normal full exam.</p>
          </Section>

          <Section icon={Table2} title="Uploading several exams at once">
            <p className="text-slate-300">
              Every file in a single drop must be the same shape. The checkboxes are set once and
              applied to the whole batch — there is no per-file setting.
            </p>

            <div className="flex flex-col gap-2.5 sm:flex-row">
              <Example
                ok
                title="One batch"
                items={['march-full.pdf  (98 q)', 'april-full.pdf  (98 q)', 'may-full.pdf   (98 q)']}
              />
              <Example
                title="Not one batch"
                items={['march-full.pdf  (98 q)', 'april-math.pdf  (44 q)', 'may-rw.pdf     (54 q)']}
              />
            </div>

            <p>
              So: upload Math-only exams with other Math-only exams, and full exams with other full
              exams. If a file has a different shape, drop it separately with its own boxes ticked.
              Mixing them does not raise an error — it quietly writes questions into the wrong rows.
            </p>
          </Section>

          <Section icon={ScrollText} title="Where questions land">
            <p>
              The sheet is a fixed 98-row template, and a question goes to the row its printed number
              names. A question that fails to transcribe leaves its row empty rather than shifting
              everything below it.
            </p>

            <div className="overflow-hidden rounded-lg border border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-800/60 text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">Section</th>
                    <th className="px-3 py-2 font-medium">Module</th>
                    <th className="px-3 py-2 font-medium">Questions</th>
                    <th className="px-3 py-2 font-medium">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {ROW_MAP.map(([section, module, count, rows]) => (
                    <tr key={`${section}-${module}`} className="border-t border-slate-800">
                      <td className="px-3 py-2 text-slate-300">{section}</td>
                      <td className="px-3 py-2 text-slate-400">{module}</td>
                      <td className="px-3 py-2 text-slate-400">{count}</td>
                      <td className="px-3 py-2 font-mono text-slate-400">{rows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section icon={KeyRound} title="Answers and answer keys">
            <p>
              If your PDF prints an answer key at the end, it is detected and skipped — those pages are
              never transcribed and never written to the sheet, even when the key starts partway down a
              page that still has real questions on it.
            </p>
            <p>
              To fill the answer column, take the key's pages to
              the <button onClick={() => navigate('/answer-key')} className="text-indigo-300 hover:underline">Answer Key</button> tab
              and drop them there, in order. Pick the sheet you want them written into, tick the same
              modules, and the letters go into column J — nothing else in the sheet is touched.
            </p>
            <p>
              Math rows also leave the three classifier columns empty. That model is trained on Reading
              and Writing only, so math questions are never sent to it.
            </p>
            <AnswerKeyNote />
          </Section>

          <Section icon={FileImage} title="If a run looks wrong">
            <p>
              Every run writes a full log to the <span className="font-mono text-slate-300">run-logs</span> folder,
              named after the exam and the time it started. It lists each page, every question found, and every
              row that was skipped or rerouted — which is usually enough to see what happened without repeating
              the run.
            </p>
          </Section>

          <Note icon={ArrowRight} className="mt-2">
            Large exams take a few minutes. Leave the tab open while one is running.
          </Note>
        </Card>
      </div>
    </Page>
  );
}

export default HowToUse;
