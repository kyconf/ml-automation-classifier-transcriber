import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  FileImage, FileText, Sparkles, RefreshCw,
  ScanText, Settings as SettingsIcon,
} from 'lucide-react';
import { useApp } from './AppContext';
import Settings, { ipc } from './Settings';

const NAV_ITEMS = [
  { path: '/image', label: 'Image', icon: FileImage },
  { path: '/pdf', label: 'PDF', icon: FileText },
  { path: '/generate', label: 'Generate', icon: Sparkles },
  { path: '/regenerate', label: 'Regenerate', icon: RefreshCw },
];

function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { busy } = useApp();
  const [showSettings, setShowSettings] = useState(false);

  // On launch, open Settings automatically if the API key, folder/sheet IDs, or
  // Google credential files aren't set yet — prompting the user to enter them.
  useEffect(() => {
    const rpc = ipc();
    if (!rpc) return;
    rpc.invoke('settings:get')
      .then((cfg) => {
        if (!cfg) return;
        const missing =
          !cfg.apiKey || !cfg.spreadsheetId || !cfg.exportFolderId || !cfg.folderId || !cfg.folderPdf ||
          !cfg.creds || Object.values(cfg.creds).some((present) => !present);
        if (missing) setShowSettings(true);
      })
      .catch(() => {});
  }, []);

  return (
    <aside className="flex h-full w-64 flex-col border-r border-slate-800 bg-slate-900">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600">
          <ScanText size={20} className="text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight text-white">Exam Transcriber</div>
          <div className="text-xs text-slate-500">Question pipeline</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1 px-3 py-2">
        <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-slate-500">
          Workflow
        </p>
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const active = location.pathname === path;
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              disabled={busy}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? 'bg-indigo-600/15 text-indigo-300'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon size={18} />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-slate-800 p-3">
        <button
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <SettingsIcon size={18} />
          Settings
        </button>
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </aside>
  );
}

export default Sidebar;
