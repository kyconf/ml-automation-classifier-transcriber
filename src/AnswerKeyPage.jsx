import React, { useState, useEffect } from 'react';
import { KeyRound, Columns3 } from 'lucide-react';
import { ComboboxDemo } from '@/components/ui/combobox';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card, Field, Note, Spinner, ExamScopeField, useExamScope } from './components/Layout';
import { DropZone } from './components/DropZone';

// Picking this in the sheet dropdown makes a fresh sheet instead of writing into
// an existing one. It is a label rather than a real sheet, so it is compared by
// identity everywhere below.
const NEW_SHEET = '＋ Write to a new sheet';

function AnswerKeyPage() {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const { setBusy, toast } = useApp();
  const scope = useExamScope();

  useEffect(() => {
    fetch(`${API_BASE}/sheet-names`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message);
        setSheetNames(data.sheetNames);
        if (data.sheetNames.length > 0) setSelectedSheet(data.sheetNames[0]);
      })
      .catch((err) => {
        console.error('Error fetching sheet names:', err);
        setError('Failed to load sheet names. Make sure the server is running.');
      })
      .finally(() => setInitialLoading(false));
  }, []);

  // Every page is staged first, then read in a single request: a module often
  // runs across a page break, and a model shown one page at a time cannot tell a
  // module's tail from a module of its own.
  const handleDroppedImages = async (files, report) => {
    setWorking(true);
    setBusy(true);

    try {
      for (const [index, file] of files.entries()) {
        report(file.name, 'working', 'uploading…');
        const query = new URLSearchParams({ name: file.name, index: String(index) });
        if (index === 0) query.set('reset', 'true');

        const response = await fetch(`${API_BASE}/upload-answer-key?${query}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'image/png' },
          body: file,
        });
        if (!response.ok) throw new Error(`Could not upload ${file.name}`);
        report(file.name, 'done', 'uploaded');
      }

      files.forEach((f) => report(f.name, 'working', 'reading the key…'));

      const response = await fetch(`${API_BASE}/transcribe-answer-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sheetName: selectedSheet === NEW_SHEET ? '' : selectedSheet,
          newSheet: selectedSheet === NEW_SHEET,
          readingWriting: scope.readingWriting,
          math: scope.math,
        }),
      });
      const data = await response.json();

      if (response.ok && data.success) {
        files.forEach((f) => report(f.name, 'done', `${data.sheetName} ${data.range}`));
        toast(data.message || 'Answer key written.', 'success');
        (data.notes || []).forEach((note) => toast(note, 'error'));
        if (data.sheetName && !sheetNames.includes(data.sheetName)) {
          setSheetNames((names) => [data.sheetName, ...names]);
          setSelectedSheet(data.sheetName);
        }
      } else {
        files.forEach((f) => report(f.name, 'error', 'failed'));
        toast(data.message || 'Could not read the answer key.', 'error');
      }
    } catch (err) {
      console.error('Error reading the answer key:', err);
      files.forEach((f) => report(f.name, 'error', 'failed'));
      toast('Could not upload the answer key pages.', 'error');
    } finally {
      setWorking(false);
      setBusy(false);
    }
  };

  const title = 'Answer Key Transcriber';
  const subtitle = 'Drop the answer key pages to fill the correct answer column.';

  if (initialLoading) {
    return (
      <Page title={title} subtitle={subtitle} connection="answerKey">
        <div className="flex justify-center pt-16"><Spinner size={28} /></div>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title={title} subtitle={subtitle} connection="answerKey">
        <Card className="mx-auto max-w-lg text-center text-rose-400">{error}</Card>
      </Page>
    );
  }

  return (
    <Page title={title} subtitle={subtitle} connection="answerKey">
      <Card className="mx-auto max-w-lg">
        <Field label="Sheet to write the answers into">
          <ComboboxDemo
            sheetNames={[NEW_SHEET, ...sheetNames]}
            selectedSheet={selectedSheet}
            onSheetSelect={setSelectedSheet}
          />
          <p className="mt-2 text-xs text-slate-500">
            Search by name to find the exam this key belongs to.
          </p>
        </Field>

        <ExamScopeField scope={scope} disabled={working} />

        <DropZone
          accept=".png,.jpg,.jpeg"
          multiple
          busy={working || !scope.valid || !selectedSheet}
          label="Drop answer key pages here"
          onFiles={handleDroppedImages}
        />

        <p className="mt-4 text-center text-xs text-slate-400">
          All pages are read together, in the order you drop them.
        </p>

        <div className="mt-6 space-y-2">
          <Note tone="warning" icon={Columns3} title="Only the answer column is touched">
            The answers go into column J of the sheet you picked, one row per question, matching
            the template's row layout. Nothing else in the sheet is read or overwritten.
          </Note>
          <Note icon={KeyRound}>
            Letters are written as bare A–D. Math student-produced responses are copied exactly as
            printed, so "36/5" stays a fraction.
          </Note>
        </div>
      </Card>
    </Page>
  );
}

export default AnswerKeyPage;
