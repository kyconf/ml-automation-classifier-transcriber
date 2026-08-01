import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { API_BASE } from '../config';

// Fetch the connected folder/sheet names once and share across pages.
let connectionCache;
function loadConnectionInfo() {
  if (!connectionCache) {
    connectionCache = fetch(`${API_BASE}/connection-info`)
      .then((r) => r.json())
      .catch(() => ({}));
  }
  return connectionCache;
}

// "Currently connected to: NAME" (or "Not connected to any folder") for a page.
function ConnectionLine({ resource }) {
  const [name, setName] = useState(undefined); // undefined = loading
  useEffect(() => {
    let alive = true;
    loadConnectionInfo().then((info) => { if (alive) setName(info?.[resource] ?? null); });
    return () => { alive = false; };
  }, [resource]);

  if (name === undefined) return null;
  return (
    <p className="mt-1 text-xs text-slate-500">
      {name
        ? <>Currently connected to: <span className="font-medium text-slate-300">{name}</span></>
        : 'Not connected to any folder'}
    </p>
  );
}

// Shared input/textarea styling used across pages.
export const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

export function Spinner({ size = 16, className = '' }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-white/30 border-t-white ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

// Page scaffold: sticky header with title/subtitle + scrollable content area.
export function Page({ title, subtitle, connection, children }) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-800 px-8 py-5">
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        {connection && <ConnectionLine resource={connection} />}
      </header>
      <div className="flex-1 overflow-auto px-8 py-8">{children}</div>
    </div>
  );
}

export function Card({ children, className = '' }) {
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/60 p-6 ${className}`}>
      {children}
    </div>
  );
}

// A standing note under a page's controls. `warning` is amber and is for things
// that change what you get out; `info` is quiet and is for operational detail.
const NOTE_TONES = {
  info: 'border-slate-700/60 bg-slate-800/40 text-slate-400',
  warning: 'border-amber-500/25 bg-amber-500/10 text-amber-200/90',
};

export function Note({ tone = 'info', icon: Icon, title, children, className = '' }) {
  return (
    <div
      className={`flex gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed ${NOTE_TONES[tone]} ${className}`}
    >
      {Icon && <Icon size={14} className="mt-[3px] shrink-0" />}
      <div className="min-w-0">
        {title && <p className="mb-1 font-semibold text-inherit">{title}</p>}
        <p>{children}</p>
      </div>
    </div>
  );
}

// Shown wherever an exam is transcribed. The transcriber is no longer asked which
// choice is correct: it is never shown an answer key, so it was solving every
// question itself and getting most of them wrong. Column J is left empty instead,
// and saying so up front is cheaper than finding an empty column later.
export function AnswerKeyNote({ className = '' }) {
  return (
    <Note tone="warning" icon={KeyRound} title="The answer column is left empty" className={className}>
      Transcription only reads what is printed on the page — it is not asked which choice is
      correct, because it has no answer key to read one from and its guesses were usually wrong.
      Fill the answer column with the Answer Key Transcriber, or by hand.
    </Note>
  );
}

// Which modules the uploaded file contains. A file holding only the math modules
// looks like a Reading and Writing exam to every automatic signal — its questions
// are numbered 1-22 with no earlier section to sit after — so the answer has to
// come from whoever dropped the file in. Both ticked is a whole exam and behaves
// exactly as before.
export function useExamScope() {
  const [readingWriting, setReadingWriting] = useState(true);
  const [math, setMath] = useState(true);
  const valid = readingWriting || math;
  return { readingWriting, setReadingWriting, math, setMath, valid };
}

function ScopeBox({ checked, onChange, label, rows, disabled }) {
  return (
    <label
      className={`flex flex-1 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
        disabled ? 'cursor-not-allowed opacity-50' : ''
      } ${checked ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-slate-700 bg-slate-800/40 hover:border-slate-600'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-800 accent-indigo-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-200">{label}</span>
        <span className="block text-xs text-slate-500">{rows}</span>
      </span>
    </label>
  );
}

export function ExamScopeField({ scope, disabled = false }) {
  const { readingWriting, setReadingWriting, math, setMath, valid } = scope;

  return (
    <div className="mb-6">
      <label className="mb-1 block text-sm font-medium text-slate-300">
        What is in this file?
      </label>
      <p className="mb-2.5 text-xs text-slate-500">
        Tick every module the file contains. This decides which rows get written.
      </p>

      <div className="flex gap-2.5">
        <ScopeBox
          checked={readingWriting}
          onChange={setReadingWriting}
          disabled={disabled}
          label="Reading and Writing"
          rows="Rows 2–55"
        />
        <ScopeBox
          checked={math}
          onChange={setMath}
          disabled={disabled}
          label="Math"
          rows="Rows 56–99"
        />
      </div>

      {!valid && (
        <p className="mt-2 text-xs text-rose-400">Pick at least one — there is nothing to transcribe otherwise.</p>
      )}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="mb-6">
      <label className="mb-2 block text-sm font-medium text-slate-300">{label}</label>
      {children}
    </div>
  );
}

export function PrimaryButton({ loading = false, children, className = '', disabled, ...props }) {
  return (
    <button
      {...props}
      disabled={loading || disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
