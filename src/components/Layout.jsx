import React, { useEffect, useState } from 'react';
import { API_BASE } from '../config';

// Fetch the connected folder/sheet names once and share across pages.
let connectionCache;
function loadConnectionInfo() {
  if (!connectionCache) {
    connectionCache = fetch(`${API_BASE}/connection-info`)
      .then((r) => r.json())
      .catch(() => ({}));
  }
  return connectionCache;
}

// "Currently connected to: NAME" (or "Not connected to any folder") for a page.
function ConnectionLine({ resource }) {
  const [name, setName] = useState(undefined); // undefined = loading
  useEffect(() => {
    let alive = true;
    loadConnectionInfo().then((info) => { if (alive) setName(info?.[resource] ?? null); });
    return () => { alive = false; };
  }, [resource]);

  if (name === undefined) return null;
  return (
    <p className="mt-1 text-xs text-slate-500">
      {name
        ? <>Currently connected to: <span className="font-medium text-slate-300">{name}</span></>
        : 'Not connected to any folder'}
    </p>
  );
}

// Shared input/textarea styling used across pages.
export const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 transition-colors focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

export function Spinner({ size = 16, className = '' }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-white/30 border-t-white ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

// Page scaffold: sticky header with title/subtitle + scrollable content area.
export function Page({ title, subtitle, connection, children }) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-800 px-8 py-5">
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        {connection && <ConnectionLine resource={connection} />}
      </header>
      <div className="flex-1 overflow-auto px-8 py-8">{children}</div>
    </div>
  );
}

export function Card({ children, className = '' }) {
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/60 p-6 ${className}`}>
      {children}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="mb-6">
      <label className="mb-2 block text-sm font-medium text-slate-300">{label}</label>
      {children}
    </div>
  );
}

export function PrimaryButton({ loading = false, children, className = '', disabled, ...props }) {
  return (
    <button
      {...props}
      disabled={loading || disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
