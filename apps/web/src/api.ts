import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  code: string;
  details: any;
  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-Requested-With'] = 'noren';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `HTTP ${res.status}`, e.details);
  }
  return json as T;
}

export const wapi = (wiki: string) => `/api/w/${encodeURIComponent(wiki)}`;
export const qs = (o: Record<string, string | number | undefined | null | boolean>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

export const pagePath = (wiki: string, page: string, query = '') =>
  `/w/${encodeURIComponent(wiki)}/p/${page.split('/').map(encodeURIComponent).join('/')}${query ? '?' + query : ''}`;

export const leaf = (page: string) => page.slice(page.lastIndexOf('/') + 1);
export const parentOf = (page: string) => (page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : null);

export function fmtDate(t?: number | null, withTime = true): string {
  if (!t) return '—';
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${s} ${p(d.getHours())}:${p(d.getMinutes())}` : s;
}

export function fmtRelative(t?: number | null): string {
  if (!t) return '—';
  const diff = Date.now() / 1000 - t;
  const d = new Date(t * 1000);
  const today = new Date();
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`;
  if (d.toDateString() === today.toDateString()) return `今日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨日';
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return fmtDate(t, false);
}

/** Small data hook: fetch JSON for a path, with reload. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const cur = useRef(path);
  cur.current = path;
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: ctrl.signal })
      .then((d) => { if (cur.current === path) { setData(d); setLoading(false); } })
      .catch((e) => { if (e.name !== 'AbortError' && cur.current === path) { setError(e); setLoading(false); } });
    return () => ctrl.abort();
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

// ---- per-viewer conveniences (never required for correctness)
export const local = {
  get<T>(key: string, d: T): T {
    try { const v = localStorage.getItem(key); return v === null ? d : (JSON.parse(v) as T); } catch { return d; }
  },
  set(key: string, v: unknown) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  },
  del(key: string) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export function pushRecentView(wiki: string, page: string) {
  const k = `noren:recent:${wiki}`;
  const list = local.get<string[]>(k, []).filter((p) => p !== page);
  list.unshift(page);
  local.set(k, list.slice(0, 10));
}
