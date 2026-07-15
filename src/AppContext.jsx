import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

const AppContext = createContext(null);

export const useApp = () => useContext(AppContext);

let toastId = 0;

export function AppProvider({ children }) {
  // `busy` is set during long operations to lock navigation.
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message, type = 'info') => {
    const id = ++toastId;
    setToasts((list) => [...list, { id, message, type }]);
    setTimeout(() => dismiss(id), 4500);
  }, [dismiss]);

  return (
    <AppContext.Provider value={{ busy, setBusy, toast }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </AppContext.Provider>
  );
}

const TOAST_STYLES = {
  success: { accent: 'border-l-emerald-500', icon: CheckCircle2, color: 'text-emerald-400' },
  error: { accent: 'border-l-rose-500', icon: AlertCircle, color: 'text-rose-400' },
  info: { accent: 'border-l-indigo-500', icon: Info, color: 'text-indigo-400' },
};

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2.5">
      {toasts.map((t) => {
        const style = TOAST_STYLES[t.type] || TOAST_STYLES.info;
        const Icon = style.icon;
        return (
          <div
            key={t.id}
            className={`flex items-start gap-3 rounded-lg border border-slate-700 border-l-4 ${style.accent} bg-slate-800 px-4 py-3 shadow-xl animate-in fade-in slide-in-from-bottom-3`}
          >
            <Icon size={18} className={`mt-0.5 shrink-0 ${style.color}`} />
            <p className="flex-1 text-sm leading-snug text-slate-100">{t.message}</p>
            <button onClick={() => onDismiss(t.id)} className="text-slate-400 transition-colors hover:text-white">
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
