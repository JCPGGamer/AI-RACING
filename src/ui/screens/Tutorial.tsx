import { useState, type ReactNode } from 'react';
import { audio } from '../../audio/audio.ts';
import { Modal } from '../components.tsx';
import { openNewLab, setPrefs } from '../store.ts';

/** Figuras simples em SVG (2D, vista de cima) para cada passo. */
const Car = ({ x, y, r = 0, c = '#4dabf7' }: { x: number; y: number; r?: number; c?: string }) => (
  <g transform={`translate(${x} ${y}) rotate(${r})`}>
    <rect x={-23} y={-10} width={8} height={4} fill="#0d0f12" />
    <rect x={-23} y={6} width={8} height={4} fill="#0d0f12" />
    <rect x={10} y={-10} width={7} height={3.5} fill="#0d0f12" />
    <rect x={10} y={6.5} width={7} height={3.5} fill="#0d0f12" />
    <path d="M20 -1.5 L20 1.5 L9 3 L4 6 L-12 6 L-19 2 L-19 -2 L-12 -6 L4 -6 L9 -3 Z" fill={c} />
    <rect x={-23} y={-8} width={4} height={16} fill={c} opacity={0.7} />
    <rect x={19} y={-10} width={4} height={20} fill={c} opacity={0.8} />
    <ellipse cx={0} cy={0} rx={4} ry={2.6} fill="#101317" />
  </g>
);

function FigSensors() {
  const angles = [-90, -60, -35, -15, 0, 15, 35, 60, 90];
  const len = [55, 70, 120, 170, 200, 160, 90, 60, 50];
  return (
    <svg viewBox="0 0 420 200" width="100%" style={{ maxWidth: 460 }} role="img" aria-label="Carro com nove raios de sensores">
      <rect x={0} y={0} width={420} height={200} fill="#16241c" />
      <path d="M0 40 Q210 10 420 40 L420 160 Q210 190 0 160 Z" fill="#3a3f47" />
      <path d="M0 40 Q210 10 420 40 M0 160 Q210 190 420 160" stroke="#f1f3f5" strokeWidth={2} fill="none" />
      {angles.map((a, i) => {
        const rad = (a * Math.PI) / 180;
        const x2 = 110 + Math.cos(rad) * len[i];
        const y2 = 100 + Math.sin(rad) * len[i] * 0.5;
        const near = len[i] < 80;
        return (
          <g key={a}>
            <line x1={110} y1={100} x2={x2} y2={y2} stroke={near ? '#ff8787' : '#8ce99a'} strokeWidth={1.5} />
            <circle cx={x2} cy={y2} r={3} fill={near ? '#ff8787' : '#8ce99a'} />
          </g>
        );
      })}
      <Car x={110} y={100} />
    </svg>
  );
}

function FigNetwork() {
  const ins = ['S−90°', 'S−35°', 'S0°', 'S+35°', 'S+90°', 'Vel'];
  const hid = [0, 1, 2, 3, 4];
  const outs = ['Direção', 'Acelerador', 'Freio'];
  return (
    <svg viewBox="0 0 420 210" width="100%" style={{ maxWidth: 460 }} role="img" aria-label="Rede neural: entradas, camada oculta e três saídas">
      {ins.map((_, i) => hid.map((_, j) => <line key={`${i}-${j}`} x1={70} y1={25 + i * 32} x2={210} y2={40 + j * 33} stroke="#34465e" strokeWidth={1} />))}
      {hid.map((_, j) => outs.map((_, k) => <line key={`${j}-${k}`} x1={210} y1={40 + j * 33} x2={340} y2={60 + k * 45} stroke="#34465e" strokeWidth={1} />))}
      {ins.map((t, i) => (
        <g key={t}>
          <circle cx={70} cy={25 + i * 32} r={9} fill="#4dabf7" />
          <text x={52} y={29 + i * 32} fill="#9aa8b8" fontSize={11} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      {hid.map((j) => (
        <circle key={j} cx={210} cy={40 + j * 33} r={9} fill="#b197fc" />
      ))}
      {outs.map((t, k) => (
        <g key={t}>
          <circle cx={340} cy={60 + k * 45} r={10} fill="#51cf66" />
          <text x={356} y={64 + k * 45} fill="#e9eef4" fontSize={12}>
            {t}
          </text>
        </g>
      ))}
    </svg>
  );
}

function FigSelection() {
  const bars = [92, 85, 80, 64, 50, 41, 30, 22, 15, 8];
  return (
    <svg viewBox="0 0 420 200" width="100%" style={{ maxWidth: 460 }} role="img" aria-label="Seleção: os melhores viram pais, elite é copiada, filhos sofrem mutação">
      {bars.map((b, i) => (
        <g key={i}>
          <rect x={20 + i * 22} y={150 - b} width={16} height={b} fill={i < 2 ? '#ffd43b' : i < 4 ? '#4dabf7' : '#34465e'} rx={3} />
        </g>
      ))}
      <text x={20} y={175} fill="#9aa8b8" fontSize={11}>
        pontuação da geração
      </text>
      <path d="M250 70 L285 70" stroke="#9aa8b8" strokeWidth={2} markerEnd="url(#a)" />
      <defs>
        <marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 Z" fill="#9aa8b8" />
        </marker>
      </defs>
      <rect x={295} y={30} width={110} height={26} rx={6} fill="#ffd43b" />
      <text x={350} y={48} fontSize={12} textAnchor="middle" fill="#1a1400">
        Elite: cópia exata
      </text>
      <rect x={295} y={64} width={110} height={26} rx={6} fill="#4dabf7" />
      <text x={350} y={82} fontSize={12} textAnchor="middle" fill="#06121f">
        Filhos + mutação
      </text>
      <rect x={295} y={98} width={110} height={26} rx={6} fill="#e9eef4" />
      <text x={350} y={116} fontSize={12} textAnchor="middle" fill="#111">
        Novos aleatórios
      </text>
    </svg>
  );
}

function FigRewards() {
  const items = [
    ['+ Progresso novo', '#51cf66', 120],
    ['+ Checkpoints', '#51cf66', 50],
    ['+ Conclusão', '#51cf66', 90],
    ['− Tempo gasto', '#ff8787', 40],
    ['− Colisão', '#ff8787', 60],
    ['− Ficar parado', '#ff8787', 30],
  ] as const;
  return (
    <svg viewBox="0 0 420 200" width="100%" style={{ maxWidth: 460 }} role="img" aria-label="Termos da recompensa de treino">
      {items.map(([t, c, w], i) => (
        <g key={t}>
          <text x={10} y={28 + i * 30} fill="#e9eef4" fontSize={13}>
            {t}
          </text>
          <rect x={150} y={16 + i * 30} width={w * 2} height={16} rx={4} fill={c} opacity={0.85} />
        </g>
      ))}
    </svg>
  );
}

function FigTest() {
  return (
    <svg viewBox="0 0 420 180" width="100%" style={{ maxWidth: 460 }} role="img" aria-label="Piloto testado em pistas que nunca viu">
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${20 + i * 135} 20)`}>
          <rect width={120} height={110} rx={10} fill="#16241c" stroke="#34465e" />
          <path d={['M20 55 Q60 5 100 55 Q60 105 20 55', 'M15 70 Q35 15 60 50 T105 40 Q100 95 15 70', 'M20 30 L100 30 L100 90 L60 60 L20 90 Z'][i]} stroke="#f1f3f5" strokeWidth={10} fill="none" opacity={0.85} />
          <text x={60} y={128} fill={i === 0 ? '#9aa8b8' : '#74c0fc'} fontSize={12} textAnchor="middle">
            {i === 0 ? 'treinou aqui' : 'pista nova'}
          </text>
        </g>
      ))}
    </svg>
  );
}

function FigCoach() {
  const steps = ['Criar configurações', 'Treinar cada uma', 'Validar (regras oficiais)', 'Manter as melhores', 'Variar e repetir'];
  return (
    <svg viewBox="0 0 420 200" width="100%" style={{ maxWidth: 460 }} role="img" aria-label="Ciclo da IA treinadora">
      {steps.map((s, i) => {
        const a = (i / steps.length) * Math.PI * 2 - Math.PI / 2;
        const x = 210 + Math.cos(a) * 140;
        const y = 100 + Math.sin(a) * 72;
        return (
          <g key={s}>
            <rect x={x - 70} y={y - 14} width={140} height={28} rx={14} fill="#1f2a37" stroke="#b197fc" />
            <text x={x} y={y + 4} fill="#e9eef4" fontSize={11.5} textAnchor="middle">
              {i + 1}. {s}
            </text>
          </g>
        );
      })}
      <text x={210} y={104} fill="#b197fc" fontSize={14} textAnchor="middle">
        🤖 orçamento fixo
      </text>
    </svg>
  );
}

function FigRanking() {
  return (
    <svg viewBox="0 0 420 170" width="100%" style={{ maxWidth: 460 }} role="img" aria-label="Envio ao ranking: o servidor reexecuta o piloto">
      <rect x={10} y={55} width={110} height={60} rx={10} fill="#1f2a37" stroke="#4dabf7" />
      <text x={65} y={80} fill="#e9eef4" fontSize={12} textAnchor="middle">
        Seu piloto
      </text>
      <text x={65} y={98} fill="#9aa8b8" fontSize={10} textAnchor="middle">
        (só o cérebro)
      </text>
      <path d="M125 85 L160 85" stroke="#9aa8b8" strokeWidth={2} />
      <rect x={165} y={45} width={110} height={80} rx={10} fill="#1f2a37" stroke="#0ca678" />
      <text x={220} y={75} fill="#e9eef4" fontSize={12} textAnchor="middle">
        Servidor
      </text>
      <text x={220} y={93} fill="#9aa8b8" fontSize={10} textAnchor="middle">
        roda a corrida oficial
      </text>
      <text x={220} y={108} fill="#9aa8b8" fontSize={10} textAnchor="middle">
        e calcula o tempo
      </text>
      <path d="M280 85 L315 85" stroke="#9aa8b8" strokeWidth={2} />
      <rect x={320} y={35} width={90} height={100} rx={10} fill="#1f2a37" stroke="#ffd43b" />
      {['1. Ana', '2. Bia', '3. Você'].map((t, i) => (
        <text key={t} x={333} y={65 + i * 22} fill={i === 2 ? '#ffd43b' : '#e9eef4'} fontSize={12}>
          {t}
        </text>
      ))}
    </svg>
  );
}

const STEPS: { title: string; fig: ReactNode; text: ReactNode }[] = [
  {
    title: '1. O que o carro percebe',
    fig: <FigSensors />,
    text: (
      <>
        <p>
          Cada carrinho tem <strong>sensores de distância</strong>: raios que medem quanto falta até a borda, à frente e nas diagonais (5, 9 ou 13 raios). Também pode saber a própria{' '}
          <strong>velocidade</strong> e o último comando de direção.
        </p>
        <p>Algumas configurações dão informações da própria pista (ângulo da curva, pontos à frente). Ele nunca recebe o traçado ideal nem comandos prontos.</p>
      </>
    ),
  },
  {
    title: '2. Como a rede decide',
    fig: <FigNetwork />,
    text: (
      <>
        <p>
          Os números dos sensores entram numa <strong>rede neural</strong>. Cada ligação tem um peso; a rede soma, mistura e decide três coisas a cada 1/60 s:{' '}
          <strong>direção</strong> (−1 a 1), <strong>acelerador</strong> e <strong>freio</strong> (0 a 1). O freio tem prioridade sobre o acelerador.
        </p>
        <p>No começo os pesos são aleatórios: os carros dirigem muito mal. É normal!</p>
      </>
    ),
  },
  {
    title: '3. Como os cérebros são escolhidos e mudam',
    fig: <FigSelection />,
    text: (
      <>
        <p>
          Ao fim de cada <strong>geração</strong>, os pilotos são ordenados pela pontuação. A <strong>elite</strong> passa igualzinha. Os outros lugares viram{' '}
          <strong>filhos</strong> dos melhores, com pequenas <strong>mutações</strong> (ruído nos pesos). Alguns pilotos <strong>novos</strong> entram para manter variedade.
        </p>
        <p>Ninguém programa a direção: a melhora vem só dessa seleção repetida.</p>
      </>
    ),
  },
  {
    title: '4. Como as recompensas mudam o comportamento',
    fig: <FigRewards />,
    text: (
      <>
        <p>
          A <strong>pontuação de treino</strong> diz o que você valoriza: avançar, passar checkpoints, completar, ir rápido, não bater, não oscilar. Só conta trecho{' '}
          <strong>novo</strong> e na direção certa — ir e voltar não rende pontos.
        </p>
        <p>Cuidado: combinações estranhas ensinam coisas estranhas. Se ficar parado custar pouco, o piloto pode aprender a não sair do lugar!</p>
      </>
    ),
  },
  {
    title: '5. Como testar o piloto',
    fig: <FigTest />,
    text: (
      <>
        <p>
          Salve o <strong>campeão oficial</strong> (o melhor pelas regras fixas: completa, depois menor tempo). Assista ao <strong>replay</strong>, compare com outros como fantasma e
          teste em <strong>pistas que ele nunca viu</strong>. Um bom piloto generaliza; um piloto "decorado" se perde.
        </p>
      </>
    ),
  },
  {
    title: '6. Como usar a treinadora',
    fig: <FigCoach />,
    text: (
      <>
        <p>
          A <strong>treinadora</strong> é uma IA que faz experimentos por você: escolhe configurações (população, mutação, rede…), treina cada uma com o mesmo orçamento de passos,
          valida pelas regras oficiais e refina as melhores. Ela explica cada decisão.
        </p>
        <p>As pistas de teste final ficam guardadas e só são usadas uma vez, no fim.</p>
      </>
    ),
  },
  {
    title: '7. Como disputar o ranking',
    fig: <FigRanking />,
    text: (
      <>
        <p>
          Crie uma conta com um apelido e envie um piloto. O <strong>servidor</strong> roda a corrida oficial de novo, com o mesmo motor do jogo, e calcula o tempo. Tempos digitados
          não valem: só voltas validadas entram no ranking público.
        </p>
        <p>O treino continua 100% no seu navegador, com ou sem internet.</p>
      </>
    ),
  },
];

export function TutorialModal({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const close = () => {
    setPrefs({ tutorialSeen: true });
    onClose();
  };
  return (
    <Modal
      title="Tutorial rápido"
      onClose={close}
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            Pular
          </button>
          <div className="dots" style={{ flex: 1 }} aria-label={`Passo ${i + 1} de ${STEPS.length}`}>
            {STEPS.map((_, k) => (
              <span key={k} className={k === i ? 'on' : ''} />
            ))}
          </div>
          <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>
            Voltar
          </button>
          {i < STEPS.length - 1 ? (
            <button
              className="btn primary"
              onClick={() => {
                audio.click();
                setI(i + 1);
              }}
            >
              Próximo
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => {
                close();
                openNewLab();
              }}
            >
              Começar a treinar
            </button>
          )}
        </>
      }
    >
      <h3>{step.title}</h3>
      <div className="tutorial-figure">{step.fig}</div>
      {step.text}
    </Modal>
  );
}
