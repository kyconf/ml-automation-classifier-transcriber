import React, { useState } from 'react';
import { FileImage, AlertTriangle } from 'lucide-react';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card, PrimaryButton } from './components/Layout';

function ImagePage() {
  const [loading, setLoading] = useState(false);
  const { setBusy, toast } = useApp();

  const handleTranscribe = async () => {
    setLoading(true);
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json();

      if (response.ok) {
        const count = data.details?.processed_files?.length ?? 0;
        toast(`Successfully processed ${count} image${count === 1 ? '' : 's'}.`, 'success');
      } else {
        toast(`Could not process files: ${data.message}`, 'error');
      }
    } catch (error) {
      console.error('Error:', error);
      toast('Could not complete the process. Please try again.', 'error');
    } finally {
      setLoading(false);
      setBusy(false);
    }
  };

  return (
    <Page title="Image Transcription" subtitle="Transcribe question images stored in your Drive folder." connection="image">
      <Card className="mx-auto flex max-w-lg flex-col items-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600/15 text-indigo-300">
          <FileImage size={26} />
        </div>
        <h2 className="text-lg font-semibold text-white">Process Images</h2>
        <p className="mt-1 mb-6 text-sm text-slate-400">
          Each image is transcribed, classified, and written to a new sheet.
        </p>
        <PrimaryButton onClick={handleTranscribe} loading={loading}>
          {loading ? 'Transcribing…' : 'Transcribe Images'}
        </PrimaryButton>

        <div className="mt-6 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle size={14} />
          Always review your images in Drive before processing.
        </div>
      </Card>
    </Page>
  );
}

export default ImagePage;
