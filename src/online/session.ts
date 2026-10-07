import { useSyncExternalStore } from 'react';
import { RankingApi, type RankingUser } from './api.ts';

/**
 * Estado da conexão com o ranking. O endereço vem de VITE_API_URL (build)
 * ou da mesma origem do jogo (/api). Sem servidor, o jogo segue local.
 */

export type OnlineStatus = 'verificando' | 'online' | 'offline';

interface OnlineState {
  status: OnlineStatus;
  user: RankingUser | null;
  lastCheck: number;
  message: string | null;
}

const TOKEN_KEY = 'evorace.token';
const USER_KEY = 'evorace.user';

let memToken: string | null = null;

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken;
  } catch {
    return memToken;
  }
}

function readUser(): RankingUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as RankingUser) : null;
  } catch {
    return null;
  }
}

export const API_BASE: string = (import.meta.env?.VITE_API_URL as string | undefined)?.trim() || '';

export const api = new RankingApi(API_BASE, readToken);

let state: OnlineState = { status: 'verificando', user: readUser(), lastCheck: 0, message: null };
const listeners = new Set<() => void>();

function set(p: Partial<OnlineState>) {
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function useOnline(): OnlineState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

export function getOnline(): OnlineState {
  return state;
}

/** Verifica se o servidor responde. Não bloqueia nada do jogo local. */
export async function checkOnline(): Promise<boolean> {
  set({ status: state.status === 'online' ? 'online' : 'verificando' });
  const r = await api.health();
  if (!r.ok) {
    set({ status: 'offline', lastCheck: Date.now(), message: r.error });
    return false;
  }
  set({ status: 'online', lastCheck: Date.now(), message: null });
  if (readToken()) {
    const me = await api.me();
    if (me.ok) saveUser(me.data.user);
    else if (me.status === 401) clearSession();
  }
  return true;
}

function saveUser(u: RankingUser | null) {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* ignora */
  }
  set({ user: u });
}

export function setSession(token: string, user: RankingUser): void {
  memToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* sem armazenamento: a sessão dura só nesta aba */
  }
  saveUser(user);
}

export function clearSession(): void {
  memToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignora */
  }
  saveUser(null);
}

export async function logout(): Promise<void> {
  await api.logout();
  clearSession();
}
