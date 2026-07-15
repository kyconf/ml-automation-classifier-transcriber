// Single source of truth for the Node/Express backend base URL.
// Override at build time with VITE_API_BASE if you change the server port.
export const API_BASE = import.meta.env?.VITE_API_BASE || 'http://localhost:3000';
