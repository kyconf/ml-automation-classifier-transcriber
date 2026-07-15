import React, { useState, useEffect } from 'react';
import { ComboboxDemo } from '@/components/ui/combobox';
import { API_BASE } from './config';
import { useApp } from './AppContext';
import { Page, Card, Field, PrimaryButton, Spinner, inputClass } from './components/Layout';

function Generate() {
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState('');
  const { setBusy, toast } = useApp();

  useEffect(() => {
    fetchSheetNames();
  }, []);

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

  const handleGenerate = async () => {
    if (!selectedSheet) {
      toast('Please select a sheet first.', 'error');
      return;
    }
    setGenerating(true);
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE}/generate-questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetName: selectedSheet, generate_prompt: generatePrompt }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast(`Generated questions in “${selectedSheet}”.`, 'success');
      } else {
        throw new Error(data.error || data.message || 'Failed to generate questions');
      }
    } catch (err) {
      console.error('Error:', err);
      toast(`Error generating questions: ${err.message}`, 'error');
    } finally {
      setGenerating(false);
      setBusy(false);
    }
  };

  if (initialLoading) {
    return (
      <Page title="Generate Questions" subtitle="Create new questions matching a sheet’s style." connection="generate">
        <div className="flex justify-center pt-16"><Spinner size={28} /></div>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Generate Questions" subtitle="Create new questions matching a sheet’s style." connection="generate">
        <Card className="mx-auto max-w-lg text-center text-rose-400">{error}</Card>
      </Page>
    );
  }

  return (
    <Page title="Generate Questions" subtitle="Create new questions matching a sheet’s style and difficulty." connection="generate">
      <Card className="mx-auto max-w-lg">
        <Field label="Sheet">
          <ComboboxDemo
            sheetNames={sheetNames}
            selectedSheet={selectedSheet}
            onSheetSelect={setSelectedSheet}
          />
        </Field>

        <Field label="Generation prompt">
          <textarea
            value={generatePrompt}
            onChange={(e) => setGeneratePrompt(e.target.value)}
            className={inputClass}
            rows={4}
            placeholder="Optional: describe what you want generated…"
          />
        </Field>

        <PrimaryButton onClick={handleGenerate} loading={generating} className="w-full">
          {generating ? 'Generating…' : 'Generate Questions'}
        </PrimaryButton>
      </Card>
    </Page>
  );
}

export default Generate;
