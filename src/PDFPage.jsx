import React, { useState } from 'react';
import { FileText, AlertTriangle } from 'lucide-react';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card, PrimaryButton } from './components/Layout';

function PDFPage() {
  const [loading, setLoading] = useState(false);
  const { setBusy, toast } = useApp();

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
    <Page title="PDF Transcription" subtitle="Convert PDF exams in your Drive folder into transcribed questions." connection="pdf">
      <Card className="mx-auto flex max-w-lg flex-col items-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600/15 text-indigo-300">
          <FileText size={26} />
        </div>
        <h2 className="text-lg font-semibold text-white">Process PDFs</h2>
        <p className="mt-1 mb-6 text-sm text-slate-400">
          Each page is converted to an image, transcribed, classified, and written to your sheet.
        </p>
        <PrimaryButton onClick={handleProcessPDFs} loading={loading}>
          {loading ? 'Processing…' : 'Transcribe PDFs'}
        </PrimaryButton>

        <div className="mt-6 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle size={14} />
          Always review your PDFs in Drive before processing.
        </div>
      </Card>
    </Page>
  );
}

export default PDFPage;
