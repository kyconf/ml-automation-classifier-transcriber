import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FileImage, FileText, Sparkles, RefreshCw, ArrowRight } from 'lucide-react';
import { Page } from './components/Layout';

const STEPS = [
  { path: '/pdf', icon: FileText, title: 'PDF', desc: 'Convert a PDF exam to images and transcribe every question.' },
  { path: '/image', icon: FileImage, title: 'Image', desc: 'Transcribe question images already in your Drive folder.' },
  { path: '/generate', icon: Sparkles, title: 'Generate', desc: 'Create new questions matching a sheet’s style and difficulty.' },
  { path: '/regenerate', icon: RefreshCw, title: 'Regenerate', desc: 'Rebuild specific rows you want to replace.' },
];

function RWPage() {
  const navigate = useNavigate();

  return (
    <Page title="Welcome" subtitle="Pick a step to get started.">
      <div className="mx-auto grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
        {STEPS.map(({ path, icon: Icon, title, desc }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            className="group flex flex-col items-start rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-left transition-colors hover:border-indigo-500/50 hover:bg-slate-900"
          >
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600/15 text-indigo-300">
              <Icon size={20} />
            </div>
            <div className="flex w-full items-center justify-between">
              <h2 className="text-base font-semibold text-white">{title}</h2>
              <ArrowRight size={16} className="text-slate-600 transition-colors group-hover:text-indigo-300" />
            </div>
            <p className="mt-1 text-sm leading-relaxed text-slate-400">{desc}</p>
          </button>
        ))}
      </div>
    </Page>
  );
}

export default RWPage;
