import { useEffect } from 'react';
import { audio } from '../audio/audio.ts';
import { checkOnline, useOnline } from '../online/session.ts';
import { db } from '../persistence/db.ts';
import { getLab } from '../lab/labSession.ts';
import { getNavGuard, navigate, openModal, setNavGuard, setPrefs, setState, useApp, type ScreenId } from './store.ts';
import { confirmDialog } from './components.tsx';
import { refreshSubmissions } from './screens/submissionWatcher.ts';
import { Home } from './screens/Home.tsx';
import { LabScreen } from './screens/Lab.tsx';
import { ResultsScreen } from './screens/Results.tsx';
import { GarageScreen } from './screens/Garage.tsx';
import { TracksScreen } from './screens/Tracks.tsx';
import { ChampionshipScreen } from './screens/Championship.tsx';
import { RankingScreen } from './screens/Ranking.tsx';
import { SettingsModal } from './screens/Settings.tsx';
import { TutorialModal } from './screens/Tutorial.tsx';
import { NewLabModal } from './screens/NewLab.tsx';

const NAV: { id: ScreenId; label: string; icon: string }[] = [
  { id: 'inicio', label: 'Início', icon: '🏁' },
  { id: 'laboratorio', label: 'Laboratório', icon: '🧪' },
  { id: 'resultados', label: 'Resultados', icon: '📈' },
  { id: 'garagem', label: 'Garagem', icon: '🧠' },
  { id: 'pistas', label: 'Pistas', icon: '🛣️' },
  { id: 'campeonato', label: 'Campeonato', icon: '🏆' },
  { id: 'ranking', label: 'Ranking', icon: '🌐' },
];

const SCREENS: ScreenId[] = NAV.map((n) => n.id);

export function App() {
  const screen = useApp((s) => s.screen);
  const prefs = useApp((s) => s.prefs);
  const modal = useApp((s) => s.modal);
  const toasts = useApp((s) => s.toasts);
  const online = useOnline();

  // Rota inicial pelo endereço (#ranking, #laboratorio/…)
  useEffect(() => {
    const fromHash = () => {
      const [scr, arg] = location.hash.replace(/^#/, '').split('/');
      if (SCREENS.includes(scr as ScreenId)) setState({ screen: scr as ScreenId, screenArg: arg ? decodeURIComponent(arg) : null });
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    void db
      .kvGet<string>('lastProjectId')
      .then((id) => id && setState({ currentProjectId: id }))
      .catch(() => undefined);
    void checkOnline().then((ok) => {
      if (ok) void refreshSubmissions();
    });
    const t = setInterval(() => void checkOnline(), 120_000);
    return () => {
      clearInterval(t);
      window.removeEventListener('hashchange', fromHash);
    };
  }, []);

  // Preferências visuais e de acessibilidade
  useEffect(() => {
    const h = document.documentElement;
    h.classList.toggle('contrast', prefs.highContrast);
    h.classList.toggle('legible', prefs.legibleFont);
    h.classList.toggle('large', prefs.largeText);
    h.classList.toggle('reduce-motion', prefs.reduceMotion);
    audio.applyPrefs(prefs);
    audio.setMusic(!prefs.muted && prefs.musicVolume > 0);
    getLab()?.setLowPower(prefs.lowPower);
  }, [prefs]);

  // Áudio só depois da primeira interação do jogador.
  useEffect(() => {
    const unlock = () => {
      audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Tutorial na primeira visita (opcional: pode fechar)
  useEffect(() => {
    if (!prefs.tutorialSeen) {
      const t = setTimeout(() => openModal('tutorial'), 600);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = async (id: ScreenId) => {
    audio.click();
    const msg = getNavGuard()?.();
    if (msg && !(await confirmDialog('Sair sem salvar?', msg, 'Sair sem salvar'))) return;
    setNavGuard(null);
    navigate(id);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => void go('inicio')} aria-label="EvoRace — ir para o início">
          <span className="brand-mark" aria-hidden>
            ▲
          </span>
          <span>
            EvoRace
            <small>Laboratório de Pilotos</small>
          </span>
        </button>
        <nav className="nav" aria-label="Áreas do jogo">
          {NAV.map((n) => (
            <button key={n.id} aria-current={screen === n.id ? 'page' : undefined} onClick={() => void go(n.id)} title={n.label}>
              <span aria-hidden>{n.icon}</span>
              <span className="lbl">{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span
            className={`badge ${online.status === 'online' ? 'online' : online.status === 'offline' ? 'err' : ''}`}
            title={online.status === 'offline' ? online.message ?? 'Ranking online indisponível' : 'Ranking online'}
          >
            {online.status === 'online' ? '● Online' : online.status === 'offline' ? '○ Offline' : '… Conectando'}
          </span>
          <button
            className="btn ghost small icon"
            aria-label={prefs.muted ? 'Ativar som' : 'Silenciar tudo'}
            aria-pressed={prefs.muted}
            title={prefs.muted ? 'Ativar som' : 'Silenciar tudo'}
            onClick={() => {
              audio.unlock();
              setPrefs({ muted: !prefs.muted });
            }}
          >
            {prefs.muted ? '🔇' : '🔊'}
          </button>
          <button className="btn ghost small icon" aria-label="Tutorial" title="Tutorial" onClick={() => openModal('tutorial')}>
            ?
          </button>
          <button className="btn ghost small icon" aria-label="Configurações" title="Configurações" onClick={() => openModal('configuracoes')}>
            ⚙
          </button>
        </div>
      </header>
      <main className="main" id="conteudo">
        {screen === 'inicio' && <Home />}
        {screen === 'laboratorio' && <LabScreen />}
        {screen === 'resultados' && <ResultsScreen />}
        {screen === 'garagem' && <GarageScreen />}
        {screen === 'pistas' && <TracksScreen />}
        {screen === 'campeonato' && <ChampionshipScreen />}
        {screen === 'ranking' && <RankingScreen />}
      </main>
      <nav className="bottom-nav" aria-label="Áreas do jogo">
        {NAV.map((n) => (
          <button key={n.id} aria-current={screen === n.id ? 'page' : undefined} onClick={() => void go(n.id)}>
            <span className="ico" aria-hidden>
              {n.icon}
            </span>
            {n.label}
          </button>
        ))}
      </nav>
      {modal === 'configuracoes' && <SettingsModal onClose={() => openModal(null)} />}
      {modal === 'tutorial' && <TutorialModal onClose={() => openModal(null)} />}
      {modal === 'novo-laboratorio' && <NewLabModal onClose={() => openModal(null)} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'erro' ? 'alert' : 'status'}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
