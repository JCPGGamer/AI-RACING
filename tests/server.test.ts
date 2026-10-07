import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBuiltinTrack } from '../src/core/builtinTracks.ts';
import { defaultExperiment } from '../src/core/config.ts';
import type { Brain } from '../src/core/nn.ts';
import { buildSubmission, officialTrack, runOfficial } from '../src/core/official.ts';
import { rulesKey } from '../src/core/rules.ts';
import { Trainer } from '../src/core/trainer.ts';
import { RankingApi } from '../src/online/api.ts';
import { createApp } from '../server/app.ts';
import { openDatabase } from '../server/db.ts';
import { ValidationQueue } from '../server/queue.ts';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

let server: Server;
let db: DatabaseSync;
let queue: ValidationQueue;
let base = '';
const tokens: Record<string, string> = {};
const apiFor = (who?: string) => new RankingApi(base, () => (who ? tokens[who] ?? null : null));

/** Treina pilotos de verdade até termos dois que completam o oval com tempos diferentes. */
function trainCompleters(): { fast: Brain; slow: Brain; fastTime: number; slowTime: number } {
  const def = getBuiltinTrack('oval-largo')!;
  const found: { brain: Brain; time: number }[] = [];
  for (const seed of ['srv-a', 'srv-b', 'srv-c', 'srv-d']) {
    const cfg = defaultExperiment('oval-largo', seed);
    cfg.inputs = { ...cfg.inputs, trackAngle: false }; // categoria "sensores"
    const tr = new Trainer(cfg, [def]);
    for (let g = 0; g < 40 && !(tr.bestOfficial?.official?.completionRate === 1); g++) tr.runGeneration();
    const b = tr.bestOfficial;
    if (b?.official?.completionRate === 1) {
      const brain = tr.brainOf(b.genome);
      const run = runOfficial(brain, officialTrack('oval-largo')!);
      if (!found.some((f) => Math.abs(f.time - run.result.time) < 1e-6)) found.push({ brain, time: run.result.time });
    }
    if (found.length >= 2) break;
  }
  if (found.length < 2) throw new Error('não foi possível treinar dois pilotos para o teste');
  found.sort((a, b) => a.time - b.time);
  return { fast: found[0].brain, slow: found[1].brain, fastTime: found[0].time, slowTime: found[1].time };
}

async function waitFor(id: number, who: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const r = await apiFor(who).submission(id);
    if (r.ok && !['aguardando', 'validando'].includes(r.data.submission.status)) return r.data.submission.status;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('validação não terminou');
}

let pilots: ReturnType<typeof trainCompleters>;

beforeAll(async () => {
  pilots = trainCompleters();
  db = openDatabase(':memory:');
  queue = new ValidationQueue(db, { pollMs: 50 });
  server = createApp({ db, queue, limits: { maxSubmissionsPerHour: 100, registerPerHour: 100 } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  queue.start();
}, 180_000);

afterAll(async () => {
  queue.stop();
  await new Promise((r) => server.close(r));
  db.close();
});

describe('ranking público', () => {
  it('consulta pública sem login', async () => {
    const r = await apiFor().leaderboard({ track: 'oval-largo', category: 'sensores' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.rows).toEqual([]);
      expect(r.data.current).toBe(true);
    }
    const m = await apiFor().meta();
    expect(m.ok && m.data.tracks.length).toBe(5);
  });

  it('cadastro, login e identidade', async () => {
    const reg = await apiFor().register('Ana Piloto', 'segredo123');
    expect(reg.ok).toBe(true);
    if (reg.ok) tokens.ana = reg.data.token;
    const dup = await apiFor().register('ana piloto', 'outrasenha');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.status).toBe(409);
    const bad = await apiFor().login('Ana Piloto', 'errada!!');
    expect(bad.ok).toBe(false);
    const good = await apiFor().login('ANA PILOTO', 'segredo123');
    expect(good.ok).toBe(true);
    const me = await apiFor('ana').me();
    expect(me.ok && me.data.user.nickname).toBe('Ana Piloto');
    const b = await apiFor().register('Bruno', 'segredo456');
    if (b.ok) tokens.bruno = b.data.token;
  });

  it('envio exige identidade', async () => {
    const r = await apiFor().submit(buildSubmission(pilots.fast, 'oval-largo', 'sensores', 'X'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejeita modelos inválidos', async () => {
    const p = buildSubmission(pilots.fast, 'oval-largo', 'sensores', 'Quebrado');
    p.brain.genome = p.brain.genome.slice(0, 40); // pesos faltando
    const r = await apiFor('ana').submit(p);
    expect(r.ok && r.data.submission.status).toBe('rejeitado');
    // entrada de pista proibida na categoria "sensores"
    const p2 = buildSubmission({ ...pilots.fast }, 'oval-largo', 'sensores', 'Trapaça');
    p2.brain.inputs = { ...p2.brain.inputs, trackAngle: true };
    const r2 = await apiFor('ana').submit(p2);
    expect(r2.ok && r2.data.submission.status).toBe('rejeitado');
    // pista desconhecida / regras antigas
    const p3 = { ...buildSubmission(pilots.fast, 'oval-largo', 'sensores', 'Velho'), rulesVersion: 'r0.f0.p0' };
    const r3 = await apiFor('ana').submit(p3);
    expect(r3.ok && r3.data.submission.status).toBe('rejeitado');
  });

  it('o tempo é calculado pelo servidor (tempo enviado é ignorado) e bate com a simulação local', async () => {
    const payload = { ...buildSubmission(pilots.slow, 'oval-largo', 'sensores', 'Lento'), time: 1.0, officialTime: 1.0 };
    const r = await apiFor('ana').submit(payload as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await waitFor(r.data.submission.id, 'ana')).toBe('aprovado');
    const board = await apiFor().leaderboard({ track: 'oval-largo', category: 'sensores' });
    expect(board.ok && board.data.rows[0].time).toBe(pilots.slowTime); // idêntico ao cliente (mesmo núcleo)
    expect(board.ok && board.data.rows[0].nickname).toBe('Ana Piloto');
  });

  it('não existe rota para gravar tempo diretamente', async () => {
    const res = await fetch(`${base}/api/records`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.ana}`, 'Content-Type': 'application/json' }, body: '{"time":0.5}' });
    expect(res.status).toBe(404);
  });

  it('atualiza o recorde só quando melhora e mantém um por jogador', async () => {
    const again = await apiFor('ana').submit(buildSubmission(pilots.slow, 'oval-largo', 'sensores', 'Lento de novo'));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(await waitFor(again.data.submission.id, 'ana')).toBe('aprovado');
    const subs = await apiFor('ana').submissions();
    const last = subs.ok ? subs.data.submissions.find((s) => s.id === again.data.submission.id) : null;
    expect(last?.improved).toBe(false);

    const faster = await apiFor('ana').submit(buildSubmission(pilots.fast, 'oval-largo', 'sensores', 'Rápido'));
    if (!faster.ok) throw new Error(faster.error);
    expect(await waitFor(faster.data.submission.id, 'ana')).toBe('aprovado');
    const board = await apiFor().leaderboard({ track: 'oval-largo', category: 'sensores' });
    expect(board.ok && board.data.total).toBe(1);
    expect(board.ok && board.data.rows[0].time).toBe(pilots.fastTime);
    expect(board.ok && board.data.rows[0].pilotName).toBe('Rápido');
  });

  it('separa por pista, categoria e versão', async () => {
    const b = await apiFor('bruno').submit(buildSubmission(pilots.slow, 'oval-largo', 'aberta', 'Bruno Aberto'));
    if (!b.ok) throw new Error(b.error);
    expect(await waitFor(b.data.submission.id, 'bruno')).toBe('aprovado');
    const sens = await apiFor().leaderboard({ track: 'oval-largo', category: 'sensores' });
    const open = await apiFor().leaderboard({ track: 'oval-largo', category: 'aberta' });
    const other = await apiFor().leaderboard({ track: 'curvas-s', category: 'sensores' });
    const oldVersion = await apiFor().leaderboard({ track: 'oval-largo', category: 'sensores', version: 'r0.f0.p0' });
    expect(sens.ok && sens.data.rows.map((r) => r.nickname)).toEqual(['Ana Piloto']);
    expect(open.ok && open.data.rows.map((r) => r.nickname)).toEqual(['Bruno']);
    expect(other.ok && other.data.total).toBe(0);
    expect(oldVersion.ok && oldVersion.data.total).toBe(0);
    expect(oldVersion.ok && oldVersion.data.current).toBe(false);
  });

  it('piloto que não completa recebe "não concluiu"', async () => {
    const cfg = defaultExperiment('oval-largo', 'ruim');
    cfg.inputs = { ...cfg.inputs, trackAngle: false };
    const tr = new Trainer(cfg, [getBuiltinTrack('oval-largo')!]);
    // pior indivíduo da primeira geração
    tr.runGeneration();
    const worst = tr.lastResults[tr.lastResults.length - 1];
    const brain = tr.brainOf(tr.population.find((p) => p.id === worst.id)?.genome ?? tr.population[tr.population.length - 1].genome);
    const r = await apiFor('bruno').submit(buildSubmission(brain, 'curvas-s', 'sensores', 'Ruim'));
    if (!r.ok) throw new Error(r.error);
    expect(await waitFor(r.data.submission.id, 'bruno')).toBe('nao_concluiu');
  });

  it('minha posição, detalhes e replay oficial', async () => {
    const me = await apiFor('ana').myPosition({ track: 'oval-largo', category: 'sensores' });
    expect(me.ok && me.data.position).toBe(1);
    const board = await apiFor().leaderboard({ track: 'oval-largo', category: 'sensores' });
    if (!board.ok) throw new Error('sem ranking');
    const id = board.data.rows[0].recordId;
    const det = await apiFor().record(id);
    expect(det.ok && det.data.rules.length).toBeGreaterThan(5);
    const rep = await apiFor().replay(id);
    expect(rep.ok).toBe(true);
    if (rep.ok) {
      expect(typeof rep.data.frames).toBe('string');
      expect(rep.data.meta.completed).toBe(true);
      expect(rep.data.meta.time).toBe(pilots.fastTime);
    }
  });

  it('pagina resultados', async () => {
    const t = officialTrack('curvas-s')!;
    const now = Date.now();
    for (let i = 0; i < 27; i++) {
      const uid = Number(db.prepare('INSERT INTO users (nickname, nickname_key, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(`p${i}`, `p${i}`, 'x', 'x', now).lastInsertRowid);
      const sid = Number(
        db
          .prepare("INSERT INTO submissions (user_id, track_id, category_id, rules_version, pilot_name, payload, status, created_at) VALUES (?, 'curvas-s', 'aberta', ?, 'p', '{}', 'aprovado', ?)")
          .run(uid, rulesKey(t.def), now).lastInsertRowid,
      );
      db.prepare("INSERT INTO records (user_id, track_id, category_id, rules_version, time, pilot_name, submission_id, achieved_at) VALUES (?, 'curvas-s', 'aberta', ?, ?, 'p', ?, ?)").run(uid, rulesKey(t.def), 40 + i, sid, now);
    }
    const p1 = await apiFor().leaderboard({ track: 'curvas-s', category: 'aberta', page: 1, pageSize: 10 });
    const p3 = await apiFor().leaderboard({ track: 'curvas-s', category: 'aberta', page: 3, pageSize: 10 });
    expect(p1.ok && p1.data.total).toBe(27);
    expect(p1.ok && p1.data.rows.length).toBe(10);
    expect(p3.ok && p3.data.rows.length).toBe(7);
    expect(p3.ok && p3.data.rows[0].position).toBe(21);
    expect(p3.ok && p3.data.rows[0].time).toBe(60);
  });

  it('limita envios pendentes por jogador', async () => {
    queue.paused = true;
    const reg = await apiFor().register('Carla', 'segredo789');
    if (reg.ok) tokens.carla = reg.data.token;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await apiFor('carla').submit(buildSubmission(pilots.slow, 'oval-largo', 'sensores', `C${i}`)));
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3].ok).toBe(false);
    if (!results[3].ok) expect(results[3].status).toBe(429);
    queue.paused = false;
    await queue.drain();
  });

  it('URL malformada não derruba o servidor', async () => {
    const res = await fetch(`${base}/%E0%A4%A`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const health = await apiFor().health();
    expect(health.ok).toBe(true);
  });

  it('página enorme e corpo grande demais respondem com erro claro', async () => {
    const r = await apiFor().leaderboard({ track: 'oval-largo', category: 'sensores', page: 1e300 as number });
    expect(r.ok).toBe(true);
    const big = await fetch(`${base}/api/submissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.ana}`, 'Content-Type': 'application/json' },
      body: 'x'.repeat(400_000),
    });
    expect(big.status).toBe(413);
  });

  it('envios simultâneos não furam o limite da fila', async () => {
    queue.paused = true;
    const reg = await apiFor().register('Dani', 'segredo321');
    if (reg.ok) tokens.dani = reg.data.token;
    const payload = buildSubmission(pilots.slow, 'oval-largo', 'sensores', 'Paralelo');
    const results = await Promise.all(Array.from({ length: 12 }, () => apiFor('dani').submit(payload)));
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect(results.filter((r) => !r.ok && r.status === 429).length).toBe(9);
    queue.paused = false;
    await queue.drain();
  });

  it('arquivos estáticos não vazam pastas vizinhas', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'evorace-static-'));
    mkdirSync(join(root, 'static'));
    mkdirSync(join(root, 'static-secret'));
    writeFileSync(join(root, 'static', 'index.html'), '<!doctype html><title>ok</title>');
    writeFileSync(join(root, 'static-secret', 'secret.txt'), 'SEGREDO');
    const db2 = openDatabase(':memory:');
    const q2 = new ValidationQueue(db2, { useWorker: false });
    const srv = createApp({ db: db2, queue: q2, staticDir: join(root, 'static') });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const b2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    for (const path of ['/..%2fstatic-secret/secret.txt', '/..%5cstatic-secret%5csecret.txt', '/%2e%2e/static-secret/secret.txt']) {
      const text = await (await fetch(b2 + path)).text();
      expect(text).not.toContain('SEGREDO');
    }
    expect(await (await fetch(b2 + '/')).text()).toContain('ok');
    await new Promise((r) => srv.close(r));
    db2.close();
  });

  it('cliente trata falha de conexão', async () => {
    const offline = new RankingApi('http://127.0.0.1:9', () => null, undefined, 2000);
    const r = await offline.leaderboard({ track: 'oval-largo', category: 'sensores' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offline).toBe(true);
      expect(r.error).toContain('indisponível');
    }
  });
});
