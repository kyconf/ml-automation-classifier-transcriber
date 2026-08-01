import React, { useRef, useState } from 'react';
import { UploadCloud, FileCheck2, FileWarning, Loader2 } from 'lucide-react';

// Drag-and-drop file picker. Files are handed to onFiles(files, report), where
// report(name, status, note) drives the per-file list shown underneath.
export function DropZone({
  accept,
  multiple = true,
  label = 'Drop files here',
  hint,
  busy = false,
  onFiles,
}) {
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState([]);
  const inputRef = useRef(null);

  const matches = (file) => {
    const exts = accept.split(',').map((s) => s.trim().toLowerCase());
    return exts.some((ext) => file.name.toLowerCase().endsWith(ext));
  };

  const report = (name, status, note) =>
    setItems((prev) => prev.map((it) => (it.name === name ? { ...it, status, note } : it)));

  const start = async (fileList) => {
    const files = Array.from(fileList).filter(matches);
    if (!files.length) return;

    const chosen = multiple ? files : files.slice(0, 1);
    setItems(chosen.map((f) => ({ name: f.name, status: 'pending', note: '' })));
    await onFiles(chosen, report);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (!busy) start(e.dataTransfer.files);
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) inputRef.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          busy
            ? 'cursor-not-allowed border-slate-800 bg-slate-900/40 opacity-60'
            : dragging
              ? 'border-indigo-400 bg-indigo-500/10'
              : 'border-slate-700 bg-slate-900/40 hover:border-indigo-500/50 hover:bg-slate-900/70'
        }`}
      >
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600/15 text-indigo-300">
          <UploadCloud size={24} />
        </div>
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="mt-1 text-xs text-slate-400">
          {hint || <>or <span className="text-indigo-300">click to browse</span></>}
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(e) => { start(e.target.files); e.target.value = ''; }}
        />
      </div>

      {items.length > 0 && (
        <ul className="mt-4 space-y-2 text-left">
          {items.map((it) => (
            <li
              key={it.name}
              className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm"
            >
              {it.status === 'working' && <Loader2 size={15} className="shrink-0 animate-spin text-indigo-300" />}
              {it.status === 'done' && <FileCheck2 size={15} className="shrink-0 text-emerald-400" />}
              {it.status === 'error' && <FileWarning size={15} className="shrink-0 text-rose-400" />}
              {it.status === 'pending' && <span className="h-[15px] w-[15px] shrink-0 rounded-full border border-slate-600" />}

              <span className="min-w-0 flex-1 truncate text-slate-200">{it.name}</span>
              {it.note && (
                <span className={`shrink-0 text-xs ${it.status === 'error' ? 'text-rose-300' : 'text-slate-400'}`}>
                  {it.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// "or use the Drive folder instead" — the original flow, kept as the secondary path.
export function FolderFallback({ onClick, loading, children }) {
  return (
    <div className="mt-6 flex flex-col items-center gap-2 border-t border-slate-800 pt-5">
      <p className="text-xs text-slate-500">Already put the files in your Drive folder?</p>
      <button
        onClick={onClick}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:border-indigo-500/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading && <Loader2 size={14} className="animate-spin" />}
        {children}
      </button>
    </div>
  );
}

export default DropZone;
