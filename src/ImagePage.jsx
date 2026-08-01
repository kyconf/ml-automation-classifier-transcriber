import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card } from './components/Layout';
import { DropZone, FolderFallback } from './components/DropZone';

function ImagePage() {
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { setBusy, toast } = useApp();

  // Images are staged first, then transcribed in one go so the whole batch lands
  // in a single sheet rather than one sheet per image.
  const handleDroppedImages = async (files, report) => {
    setUploading(true);
    setBusy(true);

    try {
      for (const [index, file] of files.entries()) {
        report(file.name, 'working', 'uploading…');
        const query = `name=${encodeURIComponent(file.name)}${index === 0 ? '&reset=true' : ''}`;
        const response = await fetch(`${API_BASE}/upload-image?${query}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'image/png' },
          body: file,
        });
        if (!response.ok) throw new Error(`Could not upload ${file.name}`);
        report(file.name, 'done', 'uploaded');
      }

      files.forEach((f) => report(f.name, 'working', 'transcribing…'));

      const response = await fetch(`${API_BASE}/transcribe-uploaded`, { method: 'POST' });
      const data = await response.json();

      if (response.ok && data.success) {
        files.forEach((f) => report(f.name, 'done', data.sheetName));
        toast(data.message || 'Images transcribed.', 'success');
      } else {
        files.forEach((f) => report(f.name, 'error', 'failed'));
        toast(data.message || 'Could not transcribe the images.', 'error');
      }
    } catch (error) {
      console.error('Error uploading images:', error);
      files.forEach((f) => report(f.name, 'error', 'failed'));
      toast('Could not upload the images.', 'error');
    } finally {
      setUploading(false);
      setBusy(false);
    }
  };

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
    <Page title="Image Transcription" subtitle="Drop question images to transcribe them into a new sheet." connection="image">
      <Card className="mx-auto max-w-lg">
        <DropZone
          accept=".png,.jpg,.jpeg"
          multiple
          busy={uploading || loading}
          label="Drop question images here"
          onFiles={handleDroppedImages}
        />

        <p className="mt-4 text-center text-xs text-slate-400">
          All dropped images are transcribed together into one new sheet, in filename order.
        </p>

        <FolderFallback onClick={handleTranscribe} loading={loading}>
          {loading ? 'Transcribing…' : 'Transcribe from Drive folder'}
        </FolderFallback>

        <div className="mt-6 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle size={14} />
          Images are processed in filename order, so name them accordingly.
        </div>
      </Card>
    </Page>
  );
}

export default ImagePage;
