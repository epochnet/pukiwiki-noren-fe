import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export interface Toast { id: number; kind: 'ok' | 'error' | 'info'; text: string }
export interface AiRequest { message?: string; page?: string; selection?: string; draft?: string }

interface AppState {
  wiki: string;
  me: string;
  caps: any;
  currentPage: string | null;
  setCurrentPage: (p: string | null) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  toasts: Toast[];
  aiOpen: boolean;
  aiRequest: AiRequest | null;
  openAi: (req?: AiRequest) => void;
  closeAi: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  treeVersion: number;
  bumpTree: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ wiki, me, caps, children }: { wiki: string; me: string; caps: any; children: ReactNode }) {
  const [currentPage, setCurrentPage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiRequest, setAiRequest] = useState<AiRequest | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  const openAi = useCallback((req?: AiRequest) => { setAiOpen(true); setAiRequest(req ? { ...req } : null); }, []);
  const closeAi = useCallback(() => setAiOpen(false), []);
  const bumpTree = useCallback(() => setTreeVersion((v) => v + 1), []);

  const value = useMemo(() => ({
    wiki, me, caps, currentPage, setCurrentPage, toast, toasts, aiOpen, aiRequest, openAi, closeAi,
    paletteOpen, setPaletteOpen, treeVersion, bumpTree,
  }), [wiki, me, caps, currentPage, toast, toasts, aiOpen, aiRequest, openAi, closeAi, paletteOpen, treeVersion, bumpTree]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider missing');
  return v;
}
