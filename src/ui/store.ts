import { useSyncExternalStore } from 'react';

/** Estado global simples da interface (navegação, preferências, avisos). */

export type ScreenId = 'inicio' | 'laboratorio' | 'resultados' | 'garagem' | 'pistas' | 'campeonato' | 'ranking';

export interface Prefs {
  musicVolume: number;
  sfxVolume: number;
  engineVolume: number;
  muted: boolean;
  reduceMotion: boolean;
  legibleFont: boolean;
  largeText: boolean;
  highContrast: boolean;
  hideSensors: boolean;
  hideEffects: boolean;
  lowPower: boolean;
  basicMode: boolean;
  showCheckpoints: boolean;
  tutorialSeen: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  musicVolume: 0.35,
  sfxVolume: 0.6,
  engineVolume: 0.4,
  muted: false,
  reduceMotion: false,
  legibleFont: false,
  largeText: false,
  highContrast: false,
  hideSensors: false,
  hideEffects: false,
  lowPower: false,
  basicMode: true,
  showCheckpoints: false,
  tutorialSeen: false,
};

export interface Toast {
  id: number;
  kind: 'info' | 'sucesso' | 'erro' | 'aviso';
  text: string;
}

export interface AppState {
  screen: ScreenId;
  /** Parâmetro opcional da tela (ex.: aba ou item selecionado) */
  screenArg: string | null;
  prefs: Prefs;
  currentProjectId: string | null;
  toasts: Toast[];
  modal: null | 'configuracoes' | 'tutorial' | 'novo-laboratorio';
  /** Incrementado quando dados locais mudam, para as listas recarregarem */
  dataVersion: number;
  /** Valores iniciais do modal "Novo laboratório" */
  newLab: NewLabPreset | null;
}

export interface NewLabPreset {
  trackId?: string;
  /** Começa o experimento a partir deste piloto (só o campeão, sem histórico) */
  pilotId?: string;
  /** Usa uma configuração salva */
  configId?: string;
  name?: string;
}

let state: AppState = {
  screen: 'inicio',
  screenArg: null,
  prefs: loadPrefs(),
  currentProjectId: null,
  toasts: [],
  modal: null,
  dataVersion: 0,
  newLab: null,
};

const listeners = new Set<() => void>();

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem('evorace.prefs');
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    /* sem armazenamento: usa padrões */
  }
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return { ...DEFAULT_PREFS, reduceMotion: true };
  return { ...DEFAULT_PREFS };
}

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  if (p.prefs) {
    try {
      localStorage.setItem('evorace.prefs', JSON.stringify(state.prefs));
    } catch {
      /* ignora */
    }
  }
  for (const l of listeners) l();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export function navigate(screen: ScreenId, arg: string | null = null): void {
  setState({ screen, screenArg: arg });
  try {
    history.replaceState(null, '', `#${screen}${arg ? `/${encodeURIComponent(arg)}` : ''}`);
  } catch {
    /* ignora */
  }
}

export function setPrefs(p: Partial<Prefs>): void {
  setState((s) => ({ prefs: { ...s.prefs, ...p } }));
}

let toastId = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500): void {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function dataChanged(): void {
  setState((s) => ({ dataVersion: s.dataVersion + 1 }));
}

export function openModal(m: AppState['modal']): void {
  setState({ modal: m });
}

export function openNewLab(preset: NewLabPreset = {}): void {
  setState({ modal: 'novo-laboratorio', newLab: preset });
}

/** Proteção contra sair de uma tela com alterações não salvas (ex.: editor de pistas). */
let navGuard: (() => string | null) | null = null;
export function setNavGuard(fn: (() => string | null) | null): void {
  navGuard = fn;
}
export function getNavGuard(): (() => string | null) | null {
  return navGuard;
}
