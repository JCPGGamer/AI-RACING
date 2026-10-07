import { useId, useState, type FormEvent } from 'react';
import { audio } from '../../audio/audio.ts';
import { logout, setSession, useOnline, api } from '../../online/session.ts';
import { Seg } from '../components.tsx';
import { toast } from '../store.ts';
import { resetSubmissions } from './submissionWatcher.ts';

/**
 * Acesso à identidade do jogador: entrar ou criar conta com apelido e senha.
 * A senha só vive no campo do formulário enquanto o jogador digita: não é
 * salva, nem mostrada, nem registrada. O servidor devolve um código de sessão.
 */

type Mode = 'entrar' | 'criar';

const NICK_CHARS = /^[\p{L}\p{N}_.\- ]+$/u;

function nicknameProblem(raw: string): string | null {
  const t = raw.normalize('NFC').trim();
  if (t.length < 3 || t.length > 20) return 'O apelido deve ter de 3 a 20 caracteres.';
  if (!NICK_CHARS.test(t)) return 'Use só letras, números, espaço, ponto, hífen ou sublinhado.';
  return null;
}

function passwordProblem(p: string): string | null {
  if (p.length < 6) return 'A senha deve ter pelo menos 6 caracteres.';
  if (p.length > 200) return 'Senha longa demais.';
  return null;
}

export function AccountPanel(props: { embedded?: boolean }) {
  const online = useOnline();
  const [mode, setMode] = useState<Mode>('entrar');
  const [nick, setNick] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const uid = useId();
  const errId = `${uid}-erro`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = nicknameProblem(nick) ?? passwordProblem(pass) ?? (mode === 'criar' && pass !== pass2 ? 'As duas senhas não são iguais.' : null);
    if (problem) {
      setError(problem);
      audio.error();
      return;
    }
    setBusy(true);
    setError(null);
    const name = nick.normalize('NFC').trim();
    const r = mode === 'criar' ? await api.register(name, pass) : await api.login(name, pass);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      audio.error();
      return;
    }
    setPass('');
    setPass2('');
    setSession(r.data.token, r.data.user);
    audio.click();
    toast(mode === 'criar' ? `Conta criada! Bem-vindo, ${r.data.user.nickname}.` : `Olá, ${r.data.user.nickname}! Você entrou no ranking.`, 'sucesso');
  };

  const leave = async () => {
    setLeaving(true);
    await logout();
    resetSubmissions();
    setLeaving(false);
    toast('Você saiu da conta. O jogo continua funcionando normalmente.', 'info');
  };

  const body = online.user ? (
    <div className="stack">
      <p style={{ margin: 0 }}>
        Você está conectado como <strong>{online.user.nickname}</strong>.
      </p>
      <p className="field-hint" style={{ margin: 0 }}>
        Seus envios ao ranking aparecem com este apelido. Treinar e salvar pilotos continua igual, com ou sem conta.
      </p>
      <div>
        <button type="button" className="btn" onClick={() => void leave()} disabled={leaving}>
          {leaving ? 'Saindo…' : 'Sair'}
        </button>
      </div>
    </div>
  ) : (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate aria-describedby={error ? errId : undefined}>
      <Seg<Mode>
        ariaLabel="Entrar ou criar conta"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
          setPass2('');
        }}
        options={[
          { value: 'entrar', label: 'Entrar' },
          { value: 'criar', label: 'Criar conta' },
        ]}
      />
      <label className="field">
        <span className="field-label">Apelido</span>
        <input
          type="text"
          name="apelido"
          autoComplete="username"
          value={nick}
          maxLength={20}
          required
          onChange={(e) => setNick(e.target.value)}
          aria-invalid={!!error && !!nicknameProblem(nick)}
        />
        <span className="field-hint">De 3 a 20 caracteres. É o nome que aparece no ranking.</span>
      </label>
      <label className="field">
        <span className="field-label">Senha</span>
        <input
          type="password"
          name="senha"
          autoComplete={mode === 'criar' ? 'new-password' : 'current-password'}
          value={pass}
          maxLength={200}
          required
          onChange={(e) => setPass(e.target.value)}
        />
        <span className="field-hint">Pelo menos 6 caracteres.</span>
      </label>
      {mode === 'criar' && (
        <label className="field">
          <span className="field-label">Repita a senha</span>
          <input type="password" name="senha2" autoComplete="new-password" value={pass2} maxLength={200} required onChange={(e) => setPass2(e.target.value)} />
        </label>
      )}
      {error && (
        <div className="callout err" role="alert" id={errId}>
          {error}
        </div>
      )}
      {online.status === 'offline' && <div className="callout warn">O ranking online está indisponível agora, então não dá para entrar. Tente mais tarde.</div>}
      <div className="btn-row">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden /> Aguarde…
            </>
          ) : mode === 'criar' ? (
            'Criar conta'
          ) : (
            'Entrar'
          )}
        </button>
      </div>
      <p className="field-hint" style={{ margin: 0 }}>
        Treinar, testar e salvar pilotos funciona sem conta. A conta serve só para enviar recordes ao ranking online e acompanhar seus envios. Sua senha vai
        apenas para o servidor do ranking e não fica guardada neste navegador.
      </p>
    </form>
  );

  if (props.embedded) return body;
  return (
    <section className="panel" aria-label="Acesso à identidade do jogador">
      <div className="panel-title">
        <h3>{online.user ? 'Sua conta' : 'Entrar no ranking'}</h3>
        <span className="badge online">🌐 Online</span>
      </div>
      {body}
    </section>
  );
}
