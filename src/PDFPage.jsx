import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card } from './components/Layout';
import { DropZone, FolderFallback } from './components/DropZone';

function PDFPage() {
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { setBusy, toast } = useApp();

  // Dropped PDFs are sent one at a time so each gets its own sheet and its own
  // line of feedback; a 50-page exam takes a while and silence is unnerving.
  const handleDroppedPDFs = async (files, report) => {
    setUploading(true);
    setBusy(true);

    let failed = 0;
    for (const file of files) {
      report(file.name, 'working', 'transcribing…');
      try {
        const response = await fetch(`${API_BASE}/upload-pdf?name=${encodeURIComponent(file.name)}`, {
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
        <DropZone
          accept=".pdf"
          multiple
          busy={uploading || loading}
          label="Drop PDF exams here"
          onFiles={handleDroppedPDFs}
        />

        <p className="mt-4 text-center text-xs text-slate-400">
          Each page is converted to an image, transcribed, classified, and written to your sheet.
        </p>

        <FolderFallback onClick={handleProcessPDFs} loading={loading}>
          {loading ? 'Processing…' : 'Transcribe from Drive folder'}
        </FolderFallback>

        <div className="mt-6 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle size={14} />
          Large exams can take several minutes. Leave this tab open.
        </div>
      </Card>
    </Page>
  );
}

export default PDFPage;
