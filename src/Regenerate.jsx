import React, { useState, useEffect } from 'react';
import { ComboboxDemo } from '@/components/ui/combobox';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card, Field, PrimaryButton, Spinner, inputClass } from './components/Layout';

function Regenerate() {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regeneratePrompt, setRegeneratePrompt] = useState('');

  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [selectedRow, setSelectedRow] = useState('');

  const [multiMode, setMultiMode] = useState(false);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [validationError, setValidationError] = useState('');

  const { setBusy, toast } = useApp();

  useEffect(() => { fetchSheetNames(); }, []);
  useEffect(() => { if (selectedSheet) fetchRows(selectedSheet); }, [selectedSheet]);

  const fetchSheetNames = async () => {
    try {
      const response = await fetch(`${API_BASE}/sheet-names`);
      const data = await response.json();
      if (data.success) {
        setSheetNames(data.sheetNames);
        if (data.sheetNames.length > 0) setSelectedSheet(data.sheetNames[0]);
      } else {
        throw new Error(data.message);
      }
    } catch (err) {
      console.error('Error fetching sheet names:', err);
      setError('Failed to load sheet names. Make sure the server is running.');
    } finally {
      setInitialLoading(false);
    }
  };

  const fetchRows = async (sheet) => {
    setRowsLoading(true);
    setSelectedRow('');
    try {
      const response = await fetch(`${API_BASE}/sheet-rows?sheetName=${encodeURIComponent(sheet)}`);
      const data = await response.json();
      if (data.success) setRows(data.rows);
      else throw new Error(data.message);
    } catch (err) {
      console.error('Error fetching rows:', err);
      setRows([]);
      toast('Could not load rows for this sheet.', 'error');
    } finally {
      setRowsLoading(false);
    }
  };

  const current = rows.find((r) => String(r.row) === String(selectedRow));

  const regenerateRows = async (rowNumbers) => {
    setRegenerating(true);
    setBusy(true);
    try {
      for (const row of rowNumbers) {
        const response = await fetch(`${API_BASE}/regenerate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheetName: selectedSheet, row, regenerate_prompt: regeneratePrompt }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Failed to regenerate row ${row}`);
      }
      const label = rowNumbers.length === 1 ? `row ${rowNumbers[0]}` : `rows ${rowNumbers[0]}–${rowNumbers[rowNumbers.length - 1]}`;
      toast(`Regenerated ${label}.`, 'success');
    } catch (err) {
      console.error('Error:', err);
      toast(`Error regenerating: ${err.message}`, 'error');
    } finally {
      setRegenerating(false);
      setBusy(false);
    }
  };

  const handleRegenerate = () => {
    setValidationError('');
    if (!selectedSheet) { toast('Please select a sheet first.', 'error'); return; }

    if (multiMode) {
      const start = Number(rangeStart);
      const end = Number(rangeEnd);
      if (!rangeStart || !rangeEnd) { setValidationError('Enter both a start and end row.'); return; }
      if (start < 2 || end < 2) { setValidationError('Rows start at 2.'); return; }
      if (end < start) { setValidationError('End row must be greater than or equal to the start row.'); return; }
      const nums = [];
      for (let r = start; r <= end; r++) nums.push(r);
      regenerateRows(nums);
    } else {
      if (!selectedRow) { setValidationError('Select a row first.'); return; }
      regenerateRows([Number(selectedRow)]);
    }
  };

  if (initialLoading) {
    return (
      <Page title="Regenerate Questions" subtitle="Rebuild specific rows you want to replace." connection="regenerate">
        <div className="flex justify-center pt-16"><Spinner size={28} /></div>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Regenerate Questions" subtitle="Rebuild specific rows you want to replace." connection="regenerate">
        <Card className="mx-auto max-w-lg text-center text-rose-400">{error}</Card>
      </Page>
    );
  }

  return (
    <Page title="Regenerate Questions" subtitle="Rebuild specific rows you want to replace." connection="regenerate">
      <Card className="mx-auto max-w-lg">
        <Field label="Sheet">
          <ComboboxDemo sheetNames={sheetNames} selectedSheet={selectedSheet} onSheetSelect={setSelectedSheet} />
        </Field>

        <label className="mb-5 flex items-center gap-2.5 text-sm font-medium text-slate-300">
          <input
            type="checkbox"
            checked={multiMode}
            onChange={(e) => { setMultiMode(e.target.checked); setValidationError(''); }}
            className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-indigo-500"
          />
          Regenerate multiple rows?
        </label>

        {multiMode ? (
          <Field label="Row range">
            <div className="flex items-center gap-2">
              <input
                type="text" inputMode="numeric" value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value.replace(/[^0-9]/g, ''))}
                className={inputClass} placeholder="From (e.g. 2)"
              />
              <span className="text-slate-500">–</span>
              <input
                type="text" inputMode="numeric" value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value.replace(/[^0-9]/g, ''))}
                className={inputClass} placeholder="To (e.g. 10)"
              />
            </div>
          </Field>
        ) : (
          <Field label="Row">
            {rowsLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-400"><Spinner size={14} /> Loading rows…</div>
            ) : (
              <select
                value={selectedRow}
                onChange={(e) => { setSelectedRow(e.target.value); setValidationError(''); }}
                className={inputClass}
              >
                <option value="">Select a row…</option>
                {rows.map((r) => (
                  <option key={r.row} value={r.row}>
                    Row {r.row}{r.content ? ` — ${truncate(r.content)}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {!multiMode && current && (
          <div className="mb-6 space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <div className="grid grid-cols-3 gap-3">
              <Meta label="Passage type" value={current.passageType} />
              <Meta label="Question type" value={current.questionType} />
              <Meta label="Difficulty" value={current.difficulty} />
            </div>
            <ReadOnly label="Passage" value={current.passage} />
            <ReadOnly label="Question" value={current.content} />
            <div className="grid grid-cols-2 gap-3">
              <Meta label="Choice A" value={current.choiceA} />
              <Meta label="Choice B" value={current.choiceB} />
              <Meta label="Choice C" value={current.choiceC} />
              <Meta label="Choice D" value={current.choiceD} />
            </div>
            <Meta label="Correct answer" value={current.answer} />
          </div>
        )}

        <Field label="Regeneration prompt">
          <textarea
            value={regeneratePrompt}
            onChange={(e) => setRegeneratePrompt(e.target.value)}
            className={inputClass}
            rows={4}
            placeholder="Optional: describe how to regenerate…"
          />
        </Field>

        {validationError && <p className="mb-3 text-sm text-rose-400">{validationError}</p>}

        <PrimaryButton onClick={handleRegenerate} loading={regenerating} className="w-full">
          {regenerating ? 'Regenerating…' : 'Regenerate Questions'}
        </PrimaryButton>
      </Card>
    </Page>
  );
}

function truncate(text, n = 60) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function Meta({ label, value }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm text-slate-200">{value || '—'}</div>
    </div>
  );
}

function ReadOnly({ label, value }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200">
        {value || '—'}
      </div>
    </div>
  );
}

export default Regenerate;
