import React, { useState } from 'react';
import { Clock } from 'lucide-react';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card, Note, AnswerKeyNote, ExamScopeField, useExamScope } from './components/Layout';
import { DropZone, FolderFallback } from './components/DropZone';

function PDFPage() {
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { setBusy, toast } = useApp();
  const scope = useExamScope();

  // Dropped PDFs are sent one at a time so each gets its own sheet and its own
  // line of feedback; a 50-page exam takes a while and silence is unnerving.
  const handleDroppedPDFs = async (files, report) => {
    setUploading(true);
    setBusy(true);

    let failed = 0;
    for (const file of files) {
      report(file.name, 'working', 'transcribing…');
      try {
        const query = new URLSearchParams({
          name: file.name,
          readingWriting: String(scope.readingWriting),
          math: String(scope.math),
        });
        const response = await fetch(`${API_BASE}/upload-pdf?${query}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: file,
        });
        const data = await response.json();

        if (response.ok && data.success) {
          report(file.name, 'done', `${data.pages} page(s) → ${data.sheetName}`);
        } else {
          failed += 1;
          report(file.name, 'error', data.message || 'failed');
        }
      } catch (error) {
        failed += 1;
        report(file.name, 'error', 'could not reach the server');
      }
    }

    toast(
      failed ? `${failed} of ${files.length} PDF(s) had problems.` : `Transcribed ${files.length} PDF(s).`,
      failed ? 'error' : 'success',
    );
    setUploading(false);
    setBusy(false);
  };

  const handleProcessPDFs = async () => {
    setLoading(true);
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE}/process-pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readingWriting: scope.readingWriting, math: scope.math }),
      });
      const data = await response.json();

      if (response.ok && data.success) {
        toast(data.message || 'PDFs processed successfully.', 'success');
      } else {
        toast(`Error: ${data.details || data.message || 'Could not process PDFs.'}`, 'error');
      }
    } catch (error) {
      console.error('Error processing PDFs:', error);
      toast('An error occurred while processing PDFs.', 'error');
    } finally {
      setLoading(false);
      setBusy(false);
    }
  };

  return (
    <Page title="PDF Transcription" subtitle="Drop an exam PDF to transcribe every question into a new sheet." connection="pdf">
      <Card className="mx-auto max-w-lg">
        <ExamScopeField scope={scope} disabled={uploading || loading} />

        <DropZone
          accept=".pdf"
          multiple
          busy={uploading || loading || !scope.valid}
          label="Drop PDF exams here"
          onFiles={handleDroppedPDFs}
        />

        <p className="mt-4 text-center text-xs text-slate-400">
          Each page is converted to an image, transcribed, classified, and written to your sheet.
        </p>

        <FolderFallback onClick={handleProcessPDFs} loading={loading || !scope.valid}>
          {loading ? 'Processing…' : 'Transcribe from Drive folder'}
        </FolderFallback>

        <div className="mt-6 space-y-2">
          <AnswerKeyNote />
          <Note icon={Clock}>
            Large exams can take several minutes. Leave this tab open.
          </Note>
        </div>
      </Card>
    </Page>
  );
}

export default PDFPage;
