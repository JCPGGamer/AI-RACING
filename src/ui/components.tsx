import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { audio } from '../audio/audio.ts';
import { useApp } from './store.ts';

/** Botão "?" com dica acessível (passar o mouse, focar ou tocar). */
export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="hint-btn"
        aria-label="Ajuda"
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className="tooltip">
          {text}
        </span>
      )}
    </span>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: string;
  disabled?: boolean;
  limits?: boolean;
}) {
  const id = useId();
  const fmt = props.format ?? ((v: number) => String(v));
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        <span className="row" style={{ gap: 6 }}>
          {props.label}
          {props.hint && <Hint text={props.hint} />}
        </span>
        <span className="value">{fmt(props.value)}</span>
      </label>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.limits !== false && (
        <div className="spread field-hint">
          <span>{fmt(props.min)}</span>
          <span>{fmt(props.max)}</span>
        </div>
      )}
    </div>
  );
}

export function Toggle(props: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean; description?: string }) {
  return (
    <label className="check" style={{ opacity: props.disabled ? 0.5 : 1 }}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>
        <span className="row" style={{ gap: 6 }}>
          <span style={{ fontWeight: 600 }}>{props.label}</span>
          {props.hint && <Hint text={props.hint} />}
        </span>
        {props.description && <span className="field-hint" style={{ display: 'block' }}>{props.description}</span>}
      </span>
    </label>
  );
}

export function Seg<T extends string | number>(props: { options: { value: T; label: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; ariaLabel: string; disabled?: boolean }) {
  return (
    <div className="seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-pressed={o.value === props.value}
          disabled={props.disabled}
          onClick={() => {
            audio.click();
            props.onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>(props: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          aria-selected={props.value === t.id}
          tabIndex={props.value === t.id ? 0 : -1}
          onClick={() => {
            audio.click();
            props.onChange(t.id);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const n = props.tabs.length;
            const j = (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
            props.onChange(props.tabs[j].id);
            refs.current[j]?.focus();
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn ghost icon" aria-label="Fechar" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

/** Confirmação (usada para excluir). Devolve true se o jogador confirmar. */
export function confirmDialog(title: string, text: string, confirmLabel = 'Excluir', danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: boolean) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(
      <Modal
        title={title}
        onClose={() => done(false)}
        footer={
          <>
            <button className="btn" onClick={() => done(false)}>
              Cancelar
            </button>
            <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => done(true)}>
              {confirmLabel}
            </button>
          </>
        }
      >
        <p>{text}</p>
      </Modal>,
    );
  });
}

/** Pergunta um texto (ex.: renomear). */
export function promptDialog(title: string, label: string, initial: string, okLabel = 'Salvar'): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    function Body() {
      const [v, setV] = useState(initial);
      return (
        <Modal
          title={title}
          onClose={() => done(null)}
          footer={
            <>
              <button className="btn" onClick={() => done(null)}>
                Cancelar
              </button>
              <button className="btn primary" disabled={!v.trim()} onClick={() => done(v.trim())}>
                {okLabel}
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">{label}</span>
            <input
              type="text"
              value={v}
              maxLength={60}
              autoFocus
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && v.trim()) done(v.trim());
              }}
            />
          </label>
        </Modal>
      );
    }
    root.render(<Body />);
  });
}

export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="stat" title={props.title}>
      <div className="label">{props.label}</div>
      <div className="value">{props.value}</div>
      {props.sub !== undefined && <div className="sub">{props.sub}</div>}
    </div>
  );
}

export function Empty(props: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {props.icon && <div className="big" aria-hidden>{props.icon}</div>}
      <strong>{props.title}</strong>
      {props.children && <div style={{ marginTop: 8 }}>{props.children}</div>}
    </div>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
      <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Loading({ text = 'Carregando…' }: { text?: string }) {
  return (
    <div className="row muted" role="status" style={{ padding: 16 }}>
      <span className="spinner" aria-hidden /> {text}
    </div>
  );
}

/** Hook para carregar dados assíncronos que recarregam quando os dados locais mudam. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const dataVersion = useApp((s) => s.dataVersion);
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: Error) => alive && setState({ data: undefined, error: e.message, loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept = '.json,application/json'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'evorace'
  );
}

export function fmtDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return new Date(ts).toISOString();
  }
}

export function fmtNum(v: number | null | undefined, d = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPct(v: number | null | undefined, d = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
}

export function fmtTime(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const txt = r.toFixed(3).replace('.', ',');
  return m > 0 ? `${m}:${txt.padStart(6, '0')}` : `${txt} s`;
}
