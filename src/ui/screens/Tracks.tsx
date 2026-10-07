import type { ProjectRecord } from '../../core/models.ts';
import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { audio } from '../../audio/audio.ts';
import { BUILTIN_TRACKS } from '../../core/builtinTracks.ts';
import { exportJson, ImportError, KIND_LABEL, parseImport } from '../../core/io.ts';
import { newId, type CustomTrackRecord } from '../../core/models.ts';
import type { Track, TrackDef } from '../../core/track.ts';
import { db } from '../../persistence/db.ts';
import { confirmDialog, downloadText, Empty, fmtDate, Loading, pickFile, slug, useAsync } from '../components.tsx';
import { dataChanged, openNewLab, toast, useApp } from '../store.ts';
import { TrackCanvas } from '../TrackCanvas.tsx';
import { ManualDriveModal } from './ManualDrive.tsx';
import { TrackEditor } from './TrackEditor.tsx';
import { copyName, duplicateDef, emptyShape, newTrackDef, recordFor, shapeFromDef, type TrackShape } from './trackEditing.ts';
import { PilotTestModal } from './TrackPilotTest.tsx';
import { DifficultyBadge, drawStartArrow, summaryLine, TrackStats, TrackThumb, tryBuild } from './trackUi.tsx';

/**
 * Pistas: circuitos prontos, pistas personalizadas (salvas no navegador),
 * editor, teste dirigindo e teste com um piloto da Garagem.
 */

type View = { kind: 'lista' } | { kind: 'editor'; def: TrackDef; shape: TrackShape; saved: boolean; note?: string; key: string };

type TestModal = { kind: 'dirigir' | 'piloto'; def: TrackDef; track: Track } | null;

export function TracksScreen() {
  const screenArg = useApp((s) => s.screenArg);
  const prefs = useApp((s) => s.prefs);
  const customQ = useAsync(async () => {
    const all = await db.getAll<CustomTrackRecord>('tracks');
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }, []);
  const [view, setView] = useState<View>({ kind: 'lista' });
  const [selectedId, setSelectedId] = useState<string>(BUILTIN_TRACKS[0].id);
  const [modal, setModal] = useState<TestModal>(null);
  const detailRef = useRef<HTMLElement>(null);

  const custom = customQ.data ?? [];
  const selectedDef: TrackDef = BUILTIN_TRACKS.find((t) => t.id === selectedId) ?? custom.find((r) => r.id === selectedId)?.def ?? BUILTIN_TRACKS[0];

  // Endereço #pistas/nova abre o editor; #pistas/<id> seleciona a pista.
  useEffect(() => {
    if (!screenArg) return;
    if (screenArg === 'nova' || screenArg === 'editor') openNew();
    else setSelectedId(screenArg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (id: string, scroll = true) => {
    audio.click();
    setSelectedId(id);
    if (scroll) {
      requestAnimationFrame(() => {
        const el = detailRef.current;
        if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: prefs.reduceMotion ? 'auto' : 'smooth' });
      });
    }
  };

  const openNew = () => {
    audio.click();
    const def = newTrackDef();
    setView({ kind: 'editor', def, shape: emptyShape(), saved: false, key: def.id });
  };

  const openEditor = (def: TrackDef) => {
    audio.click();
    const { shape, simplified } = shapeFromDef(def);
    if (def.builtin) {
      const copy: TrackDef = { ...newTrackDef(copyName(def.name)), description: `Cópia editável do circuito "${def.name}".` };
      setView({
        kind: 'editor',
        def: copy,
        shape,
        saved: false,
        key: copy.id,
        note: `Esta é uma cópia editável de "${def.name}". O circuito original é desenhado com ${def.points.length} pontos bem juntinhos; a cópia usa ${shape.points.length} pontos de controle com curva suave, então o traçado pode mudar um pouquinho. O original não muda. Clique em "Salvar" para guardar a cópia.`,
      });
      return;
    }
    setView({
      kind: 'editor',
      def,
      shape,
      saved: true,
      key: `${def.id}@${def.version}`,
      note: simplified
        ? `Esta pista tinha ${def.points.length} pontos muito próximos. Para facilitar a edição, o editor usa ${shape.points.length} pontos de controle com curva suave. O traçado pode mudar um pouco: confira antes de salvar.`
        : undefined,
    });
  };

  const duplicate = async (def: TrackDef) => {
    audio.click();
    const copy = duplicateDef(def, copyName(def.name));
    if (def.builtin) copy.description = `Cópia do circuito "${def.name}".`;
    try {
      await db.put<CustomTrackRecord>('tracks', recordFor(copy));
      dataChanged();
      setSelectedId(copy.id);
      toast(`Cópia criada: "${copy.name}".`, 'sucesso');
    } catch (e) {
      toast((e as Error).message, 'erro', 7000);
    }
  };

  const exportTrack = (def: TrackDef) => {
    audio.click();
    downloadText(`pista-${slug(def.name)}.json`, exportJson('pista', { def }));
    toast(`Arquivo da pista "${def.name}" gerado.`, 'sucesso', 3000);
  };

  const importTrack = async () => {
    audio.click();
    const file = await pickFile();
    if (!file) return;
    try {
      const text = await file.text();
      const res = parseImport(text);
      if (res.tipo !== 'pista') {
        toast(`Este arquivo contém: ${KIND_LABEL[res.tipo]}. Aqui só dá para importar pistas (use a Garagem para os outros tipos).`, 'aviso', 7000);
        return;
      }
      const now = Date.now();
      const def: TrackDef = { ...res.data, id: newId('pista'), builtin: false, difficulty: undefined, createdAt: now, updatedAt: now };
      await db.put<CustomTrackRecord>('tracks', recordFor(def));
      dataChanged();
      setSelectedId(def.id);
      audio.approved();
      toast(`Pista "${def.name}" importada.`, 'sucesso');
    } catch (e) {
      audio.error();
      if (e instanceof ImportError) toast(`Não foi possível importar: ${e.message}`, 'erro', 8000);
      else toast(`Falha ao importar: ${(e as Error).message}`, 'erro', 8000);
    }
  };

  const remove = async (def: TrackDef) => {
    audio.click();
    let users: string[] = [];
    try {
      const projects = await db.getAll<ProjectRecord>('projects');
      users = projects.filter((p) => (p.snapshot?.config.trackIds ?? p.config.trackIds).includes(def.id)).map((p) => p.name);
    } catch {
      /* sem lista: segue com o aviso genérico */
    }
    const ok = await confirmDialog(
      `Excluir "${def.name}"?`,
      (users.length
        ? `Ela é usada por ${users.length} laboratório(s): ${users.slice(0, 5).join(', ')}${users.length > 5 ? '…' : ''}. Eles continuam podendo retomar o treino (a pista fica guardada no laboratório), mas ela some da lista de pistas. `
        : '') + 'A pista será apagada deste navegador. Se quiser guardar uma cópia, exporte antes.',
    );
    if (!ok) return;
    try {
      await db.delete('tracks', def.id);
      dataChanged();
      setSelectedId(BUILTIN_TRACKS[0].id);
      toast(`Pista "${def.name}" excluída.`, 'info');
    } catch (e) {
      toast((e as Error).message, 'erro', 7000);
    }
  };

  const openTest = (kind: 'dirigir' | 'piloto', def: TrackDef) => {
    audio.click();
    const track = tryBuild(def);
    if (!track) {
      toast('Não foi possível montar esta pista para o teste.', 'erro');
      return;
    }
    setModal({ kind, def, track });
  };

  if (view.kind === 'editor') {
    return (
      <TrackEditor
        key={view.key}
        def={view.def}
        shape={view.shape}
        saved={view.saved}
        note={view.note}
        onExit={(id) => {
          setView({ kind: 'lista' });
          if (id) setSelectedId(id);
        }}
      />
    );
  }

  return (
    <div className="page">
      <div className="spread" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
        <div>
          <h1>Pistas</h1>
          <p className="muted" style={{ margin: 0, maxWidth: '62ch' }}>
            Escolha um circuito para treinar seus pilotos, crie o seu próprio no editor ou teste se uma pista é possível de dirigir.
          </p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => void importTrack()}>
            ⬆ Importar pista
          </button>
          <button className="btn primary" onClick={openNew}>
            ＋ Criar pista
          </button>
        </div>
      </div>

      <TrackDetail
        ref={detailRef}
        def={selectedDef}
        record={custom.find((r) => r.id === selectedDef.id) ?? null}
        showCheckpoints={prefs.showCheckpoints}
        onTrain={() => {
          audio.click();
          openNewLab({ trackId: selectedDef.id });
        }}
        onEdit={() => openEditor(selectedDef)}
        onDuplicate={() => void duplicate(selectedDef)}
        onExport={() => exportTrack(selectedDef)}
        onDelete={() => void remove(selectedDef)}
        onDrive={() => openTest('dirigir', selectedDef)}
        onPilot={() => openTest('piloto', selectedDef)}
      />

      <section style={{ marginTop: 24 }} aria-labelledby="titulo-prontos">
        <h2 id="titulo-prontos">Circuitos prontos</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          Do mais fácil ao mais difícil. São os mesmos circuitos do ranking online.
        </p>
        <div className="cards">
          {BUILTIN_TRACKS.map((def) => (
            <TrackCard key={def.id} def={def} selected={def.id === selectedDef.id} onSelect={() => select(def.id)} />
          ))}
        </div>
      </section>

      <section style={{ marginTop: 28 }} aria-labelledby="titulo-personalizadas">
        <div className="spread">
          <h2 id="titulo-personalizadas" style={{ margin: 0 }}>
            Pistas personalizadas
          </h2>
          {custom.length > 0 && (
            <button className="btn small" onClick={openNew}>
              ＋ Criar pista
            </button>
          )}
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          Criadas por você ou importadas. Ficam salvas só neste navegador: exporte para guardar ou compartilhar.
        </p>
        {customQ.loading && !customQ.data && <Loading text="Carregando suas pistas…" />}
        {customQ.error && <div className="callout err">Não foi possível ler as pistas salvas: {customQ.error}</div>}
        {!customQ.loading && !customQ.error && custom.length === 0 && (
          <Empty icon="🛣️" title="Você ainda não criou nenhuma pista">
            <p style={{ maxWidth: '60ch', margin: '0 auto 12px' }}>
              No editor, você clica no mapa para marcar o caminho, ajusta a largura e fecha o circuito. Também dá para editar uma cópia de um circuito pronto ou
              importar uma pista de um arquivo.
            </p>
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={openNew}>
                ＋ Criar pista
              </button>
              <button className="btn" onClick={() => void importTrack()}>
                ⬆ Importar pista
              </button>
            </div>
          </Empty>
        )}
        {custom.length > 0 && (
          <div className="cards">
            {custom.map((r) => (
              <TrackCard key={r.id} def={r.def} selected={r.id === selectedDef.id} onSelect={() => select(r.id)} />
            ))}
          </div>
        )}
      </section>

      {modal?.kind === 'dirigir' && <ManualDriveModal track={modal.track} onClose={() => setModal(null)} />}
      {modal?.kind === 'piloto' && <PilotTestModal def={modal.def} track={modal.track} onClose={() => setModal(null)} />}
    </div>
  );
}

function TrackCard(props: { def: TrackDef; selected: boolean; onSelect: () => void }) {
  const { def } = props;
  const track = useMemo(() => tryBuild(def), [def]);
  return (
    <button
      type="button"
      className={`item-card${props.selected ? ' selected' : ''}`}
      aria-pressed={props.selected}
      onClick={props.onSelect}
      style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit', width: '100%' }}
    >
      <TrackThumb track={track} label={`Desenho da pista ${def.name}`} />
      <div className="spread" style={{ gap: 6 }}>
        <strong>{def.name}</strong>
        {def.builtin ? <DifficultyBadge value={def.difficulty} /> : <span className="badge local">Sua pista</span>}
      </div>
      <span className="muted" style={{ fontSize: '0.85em' }}>
        {summaryLine(track)}
      </span>
    </button>
  );
}

function TrackDetail(props: {
  ref: Ref<HTMLElement>;
  def: TrackDef;
  record: CustomTrackRecord | null;
  showCheckpoints: boolean;
  onTrain: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onDrive: () => void;
  onPilot: () => void;
}) {
  const { def } = props;
  const track = useMemo(() => tryBuild(def), [def]);
  const builtin = !!def.builtin;
  return (
    <section className="panel" ref={props.ref} aria-labelledby="titulo-pista-escolhida" style={{ scrollMarginTop: 12 }}>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="lab-stage" style={{ height: 340 }}>
          {track ? (
            <TrackCanvas
              track={track}
              showCheckpoints={props.showCheckpoints}
              ariaLabel={`Mapa da pista ${def.name}. A seta amarela mostra o sentido de corrida.`}
              onDraw={({ ctx, cam }) => drawStartArrow(ctx, track, cam.scale)}
            >
              <div className="legend">
                <span>Seta amarela: sentido de corrida</span>
                <span>Roda do mouse: zoom · arrastar: mover · duplo clique: voltar</span>
              </div>
            </TrackCanvas>
          ) : (
            <div className="empty" style={{ position: 'absolute', inset: 12 }}>
              Não foi possível montar esta pista.
            </div>
          )}
        </div>
        <div className="stack">
          <div className="spread" style={{ alignItems: 'flex-start' }}>
            <h2 id="titulo-pista-escolhida" style={{ margin: 0 }}>
              {def.name}
            </h2>
            <div className="row" style={{ gap: 6 }}>
              {builtin ? <span className="badge info">Circuito pronto</span> : <span className="badge local">Personalizada</span>}
              <DifficultyBadge value={def.difficulty} />
            </div>
          </div>
          {def.description && (
            <p className="muted" style={{ margin: 0 }}>
              {def.description}
            </p>
          )}
          {track && <TrackStats track={track} />}
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Versão</dt>
            <dd>{def.version}</dd>
            <dt>Sentido</dt>
            <dd>{def.reverse ? 'Invertido' : 'Normal'}</dd>
            {props.record && (
              <>
                <dt>Criada em</dt>
                <dd>{fmtDate(props.record.createdAt)}</dd>
                <dt>Alterada em</dt>
                <dd>{fmtDate(props.record.updatedAt)}</dd>
              </>
            )}
          </dl>
          <div className="btn-row">
            <button className="btn primary" onClick={props.onTrain} disabled={!track}>
              🧪 Treinar nesta pista
            </button>
            <button className="btn" onClick={props.onDrive} disabled={!track} title="Dirija você mesmo para conferir se a pista é possível">
              🎮 Testar dirigindo
            </button>
            <button className="btn" onClick={props.onPilot} disabled={!track} title="Veja um piloto da Garagem correr nesta pista">
              🧠 Testar com um piloto
            </button>
          </div>
          <div className="btn-row">
            <button className="btn small" onClick={props.onEdit}>
              ✏ {builtin ? 'Editar uma cópia' : 'Editar'}
            </button>
            <button className="btn small" onClick={props.onDuplicate}>
              ⧉ Duplicar
            </button>
            <button className="btn small" onClick={props.onExport}>
              ⬇ Exportar
            </button>
            {!builtin && (
              <button className="btn small danger" onClick={props.onDelete}>
                🗑 Excluir
              </button>
            )}
          </div>
          {builtin && (
            <span className="field-hint">
              Circuitos prontos não podem ser alterados (o ranking depende deles). "Editar uma cópia" abre uma versão sua no editor; "Duplicar" cria uma cópia exata.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
