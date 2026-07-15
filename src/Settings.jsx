import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Upload, Check, Loader2, KeyRound, SlidersHorizontal, HardDrive, FileSpreadsheet, ExternalLink } from 'lucide-react';

const googleDriveUrl = 'https://drive.google.com/drive/folders/1c3odLY__uNMp1-FkP7bSDtaZ90K08riA?usp=sharing';
const googleSheetsUrl = 'https://docs.google.com/spreadsheets/d/1wtaO0rdKW3WC1TBQBDRSUqQZ2t2yPsrHGnSeLJmr2pA/edit?usp=sharing';

// ipcRenderer is available because the Electron window runs with nodeIntegration.
// window.require avoids Vite trying to bundle 'electron' at build time.
export function ipc() {
  if (typeof window !== 'undefined' && window.require) {
    try { return window.require('electron').ipcRenderer; } catch { /* not in electron */ }
  }
  return null;
}

const CRED_FILES = [
  { name: 'sheets_credentials.json', label: 'Google Sheets credentials' },
  { name: 'drive_credentials.json', label: 'Google Drive credentials' },
  { name: 'drive_token.json', label: 'Google Drive token' },
];

const ADVANCED_FIELDS = [
  { key: 'spreadsheetId', label: 'Spreadsheet ID' },
  { key: 'exportFolderId', label: 'Export Folder ID' },
  { key: 'folderId', label: 'Folder ID (images)' },
  { key: 'folderPdf', label: 'Folder ID (PDFs)' },
];

export default function Settings({ onClose }) {
  const rpc = ipc();
  const [tab, setTab] = useState('credentials');
  const [showKey, setShowKey] = useState(false);
  const [values, setValues] = useState({
    apiKey: '', spreadsheetId: '', exportFolderId: '', folderId: '', folderPdf: '',
  });
  const [creds, setCreds] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!rpc) { setStatus('Settings are only available in the desktop app.'); return; }
    rpc.invoke('settings:get')
      .then((cfg) => {
        const { creds: c, ...rest } = cfg;
        setValues(rest);
        setCreds(c || {});
      })
      .catch(() => setStatus('Could not load settings. Fully quit and relaunch the app.'));
  }, [rpc]);

  const set = (key, val) => { setValues((v) => ({ ...v, [key]: val })); setDirty(true); };

  async function pickCredential(name) {
    if (!rpc) { setStatus('Settings are only available in the desktop app.'); return; }
    setStatus('');
    try {
      const res = await rpc.invoke('settings:pickCredential', name);
      if (res.error) setStatus(res.error);
      setCreds((c) => ({ ...c, [name]: res.saved }));
      if (res.saved && !res.canceled) setDirty(true);
    } catch {
      setStatus('Upload failed — fully quit and relaunch the app so the latest version loads, then try again.');
    }
  }

  async function save() {
    if (!rpc) { setStatus('Settings are only available in the desktop app.'); return; }
    setSaving(true);
    setStatus('');
    try {
      const res = await rpc.invoke('settings:save', values);
      if (res.ok) { setDirty(false); setStatus('Saved.'); }
      else setStatus(res.error || 'Could not save settings.');
    } catch {
      setStatus('Save failed — fully quit and relaunch the app, then try again.');
    } finally {
      setSaving(false);
    }
  }

  async function saveAndRestart() {
    await save();
    if (rpc) rpc.invoke('settings:relaunch');
  }

  const inputCls =
    'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 ' +
    'placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-base font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-slate-800 px-3 pt-3">
          <TabButton active={tab === 'credentials'} onClick={() => setTab('credentials')} icon={KeyRound} label="API & Credentials" />
          <TabButton active={tab === 'advanced'} onClick={() => setTab('advanced')} icon={SlidersHorizontal} label="Advanced" />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {tab === 'credentials' ? (
            <div className="flex flex-col gap-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-200">OpenAI API key</label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={values.apiKey}
                    onChange={(e) => set('apiKey', e.target.value)}
                    placeholder="sk-..."
                    className={inputCls + ' pr-10 font-mono'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-200"
                    aria-label={showKey ? 'Hide key' : 'Show key'}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-slate-200">Google credential files</p>
                <div className="flex flex-col gap-2">
                  {CRED_FILES.map(({ name, label }) => (
                    <div key={name} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-slate-200">{label}</div>
                        <div className="truncate text-xs text-slate-500">{name}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {creds[name] && (
                          <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
                            <Check size={14} /> Saved
                          </span>
                        )}
                        <button
                          onClick={() => pickCredential(name)}
                          className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                        >
                          <Upload size={13} /> {creds[name] ? 'Replace' : 'Upload'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">Uploaded once and stored securely on this machine — you won't be asked again.</p>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-slate-200">Open in browser</p>
                <div className="flex gap-2">
                  <LinkButton icon={HardDrive} label="Drive" onClick={() => window.open(googleDriveUrl, '_blank')} />
                  <LinkButton icon={FileSpreadsheet} label="Sheets" onClick={() => window.open(googleSheetsUrl, '_blank')} />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-slate-500">
                Prefilled from your current configuration. Change these only to override the defaults.
              </p>
              {ADVANCED_FIELDS.map(({ key, label }) => (
                <div key={key}>
                  <label className="mb-1.5 block text-sm font-medium text-slate-200">{label}</label>
                  <input
                    value={values[key]}
                    onChange={(e) => set(key, e.target.value)}
                    className={inputCls + ' font-mono'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-4">
          <span className="text-xs text-slate-500">{status}</span>
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving && <Loader2 size={14} className="animate-spin" />} Save
            </button>
            <button
              onClick={saveAndRestart}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save & restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LinkButton({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
    >
      <Icon size={16} />
      {label}
      <ExternalLink size={13} className="text-slate-500" />
    </button>
  );
}

function TabButton({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-t-lg px-3 py-2 text-sm font-medium transition-colors ${
        active ? 'bg-slate-900 text-indigo-300' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}
