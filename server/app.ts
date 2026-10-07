import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BUILTIN_TRACKS } from '../src/core/builtinTracks.ts';
import { parseSubmission, officialTrack } from '../src/core/official.ts';
import { PHYSICS } from '../src/core/physics.ts';
import { CATEGORIES, describeRules, getCategory, OFFICIAL_TRACK_IDS, RULES_VERSION, rulesKey } from '../src/core/rules.ts';
import { createSession, deleteSession, hashPassword, nicknameKey, userFromToken, validateNickname, validatePassword, verifyPassword, type User } from './auth.ts';
import type { ValidationQueue } from './queue.ts';
import { RateLimiter } from './ratelimit.ts';

export interface AppOptions {
  db: DatabaseSync;
  queue: ValidationQueue;
  corsOrigin?: string;
  staticDir?: string | null;
  /** Confia no cabeçalho X-Forwarded-For (atrás de proxy) */
  trustProxy?: boolean;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

export const DEFAULT_LIMITS = {
  maxBodyBytes: 300_000,
  maxPendingPerUser: 3,
  maxSubmissionsPerHour: 30,
  maxQueue: 500,
  registerPerHour: 5,
  loginPer15Min: 30,
  pageSizeMax: 50,
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp(opts: AppOptions): Server {
  const { db, queue } = opts;
  const L = { ...DEFAULT_LIMITS, ...opts.limits };
  const cors = opts.corsOrigin ?? '*';
  const registerLimiter = new RateLimiter(L.registerPerHour, 3600_000);
  const loginLimiter = new RateLimiter(L.loginPer15Min, 15 * 60_000);
  const staticRoot = opts.staticDir && existsSync(opts.staticDir) ? resolve(opts.staticDir) : null;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(json);
  };

  const clientIp = (req: IncomingMessage) => {
    if (opts.trustProxy) {
      const f = req.headers['x-forwarded-for'];
      // Usa a entrada mais à direita: é a adicionada pelo nosso proxy (as da esquerda vêm do cliente).
      if (typeof f === 'string' && f) {
        const parts = f.split(',').map((x) => x.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
    }
    return req.socket.remoteAddress ?? 'desconhecido';
  };

  const readJson = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, reject) => {
      let size = 0;
      let tooBig = false;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > L.maxBodyBytes) {
          // Para de guardar, mas lê até o fim para conseguir responder 413.
          tooBig = true;
          chunks.length = 0;
          if (size > L.maxBodyBytes * 20) req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) {
          reject(new HttpError(413, 'Envio grande demais.'));
          return;
        }
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveBody(text ? JSON.parse(text) : {});
        } catch {
          reject(new HttpError(400, 'JSON inválido.'));
        }
      });
      req.on('error', reject);
    });

  const requireUser = (req: IncomingMessage): User => {
    const u = userFromToken(db, req.headers.authorization);
    if (!u) throw new HttpError(401, 'Entre com seu apelido para continuar.');
    return u;
  };

  const boardParams = (url: URL) => {
    const track = url.searchParams.get('track') ?? OFFICIAL_TRACK_IDS[0];
    const category = url.searchParams.get('category') ?? CATEGORIES[0].id;
    if (!OFFICIAL_TRACK_IDS.includes(track)) throw new HttpError(400, 'Pista fora do ranking oficial.');
    if (!getCategory(category)) throw new HttpError(400, 'Categoria desconhecida.');
    const t = officialTrack(track)!;
    const current = rulesKey(t.def);
    const version = url.searchParams.get('version') || current;
    if (!/^[a-z0-9.]{1,40}$/i.test(version)) throw new HttpError(400, 'Versão inválida.');
    return { track, category, version, current };
  };

  const publicSubmission = (r: Record<string, unknown>) => ({
    id: r.id,
    trackId: r.track_id,
    categoryId: r.category_id,
    rulesVersion: r.rules_version,
    pilotName: r.pilot_name,
    status: r.status,
    officialTime: r.official_time,
    officialProgress: r.official_progress,
    message: r.message,
    improved: r.improved === 1,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/api/health' && method === 'GET') {
      return send(res, 200, { ok: true, service: 'evorace-ranking', rulesVersion: RULES_VERSION, physicsVersion: PHYSICS.version, queue: queue.pendingCount() });
    }

    if (path === '/api/meta' && method === 'GET') {
      const versions = db
        .prepare('SELECT track_id AS trackId, category_id AS categoryId, rules_version AS rulesVersion, COUNT(*) AS count FROM records GROUP BY track_id, category_id, rules_version')
        .all();
      return send(res, 200, {
        categories: CATEGORIES,
        tracks: BUILTIN_TRACKS.map((d) => {
          const t = officialTrack(d.id)!;
          return { id: d.id, name: d.name, version: d.version, difficulty: d.difficulty, hash: t.hash, rulesVersion: rulesKey(d), rules: CATEGORIES.map((c) => ({ categoryId: c.id, items: describeRules(t, c) })) };
        }),
        versions,
      });
    }

    if (path === '/api/leaderboard' && method === 'GET') {
      const { track, category, version, current } = boardParams(url);
      const page = Math.min(1_000_000, Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1)));
      const pageSize = Math.min(L.pageSizeMax, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize')) || 20)));
      const total = (db.prepare('SELECT COUNT(*) AS n FROM records WHERE track_id = ? AND category_id = ? AND rules_version = ?').get(track, category, version) as { n: number }).n;
      const rows = db
        .prepare(
          `SELECT r.id, r.time, r.pilot_name, r.achieved_at, r.replay_id, u.nickname
           FROM records r JOIN users u ON u.id = r.user_id
           WHERE r.track_id = ? AND r.category_id = ? AND r.rules_version = ?
           ORDER BY r.time ASC, r.achieved_at ASC, r.id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(track, category, version, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
      return send(res, 200, {
        track,
        category,
        version,
        current: version === current,
        total,
        page,
        pageSize,
        rows: rows.map((r, i) => ({
          position: (page - 1) * pageSize + i + 1,
          recordId: r.id,
          nickname: r.nickname,
          pilotName: r.pilot_name,
          time: r.time,
          achievedAt: r.achieved_at,
          validated: true,
          hasReplay: r.replay_id !== null,
        })),
      });
    }

    if (path === '/api/leaderboard/me' && method === 'GET') {
      const user = requireUser(req);
      const { track, category, version } = boardParams(url);
      const mine = db
        .prepare('SELECT id, time, achieved_at, pilot_name FROM records WHERE user_id = ? AND track_id = ? AND category_id = ? AND rules_version = ?')
        .get(user.id, track, category, version) as { id: number; time: number; achieved_at: number; pilot_name: string } | undefined;
      const total = (db.prepare('SELECT COUNT(*) AS n FROM records WHERE track_id = ? AND category_id = ? AND rules_version = ?').get(track, category, version) as { n: number }).n;
      if (!mine) return send(res, 200, { position: null, total, row: null });
      const ahead = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM records WHERE track_id = ? AND category_id = ? AND rules_version = ?
             AND (time < ? OR (time = ? AND (achieved_at < ? OR (achieved_at = ? AND id < ?))))`,
          )
          .get(track, category, version, mine.time, mine.time, mine.achieved_at, mine.achieved_at, mine.id) as { n: number }
      ).n;
      return send(res, 200, {
        position: ahead + 1,
        total,
        row: { position: ahead + 1, recordId: mine.id, nickname: user.nickname, pilotName: mine.pilot_name, time: mine.time, achievedAt: mine.achieved_at, validated: true },
      });
    }

    const recMatch = /^\/api\/records\/(\d+)$/.exec(path);
    if (recMatch && method === 'GET') {
      const r = db
        .prepare(
          `SELECT r.*, u.nickname, s.created_at AS submitted_at, s.finished_at AS validated_at FROM records r
           JOIN users u ON u.id = r.user_id JOIN submissions s ON s.id = r.submission_id WHERE r.id = ?`,
        )
        .get(Number(recMatch[1])) as Record<string, unknown> | undefined;
      if (!r) throw new HttpError(404, 'Recorde não encontrado.');
      const t = officialTrack(r.track_id as string);
      const cat = getCategory(r.category_id as string);
      return send(res, 200, {
        recordId: r.id,
        nickname: r.nickname,
        pilotName: r.pilot_name,
        time: r.time,
        trackId: r.track_id,
        categoryId: r.category_id,
        rulesVersion: r.rules_version,
        achievedAt: r.achieved_at,
        submittedAt: r.submitted_at,
        validatedAt: r.validated_at,
        hasReplay: r.replay_id !== null,
        validated: true,
        rules: t && cat ? describeRules(t, cat) : [],
      });
    }

    const repMatch = /^\/api\/records\/(\d+)\/replay$/.exec(path);
    if (repMatch && method === 'GET') {
      const r = db
        .prepare('SELECT p.meta, p.frames FROM records r JOIN replays p ON p.id = r.replay_id WHERE r.id = ?')
        .get(Number(repMatch[1])) as { meta: string; frames: string } | undefined;
      if (!r) throw new HttpError(404, 'Replay oficial indisponível.');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(`{"meta":${r.meta},"frames":${JSON.stringify(r.frames)}}`);
      return;
    }

    if (path === '/api/auth/register' && method === 'POST') {
      if (!registerLimiter.take(clientIp(req))) throw new HttpError(429, 'Muitos cadastros deste endereço. Tente mais tarde.');
      const body = (await readJson(req)) as { nickname?: unknown; password?: unknown };
      const nErr = validateNickname(body.nickname);
      if (nErr) throw new HttpError(400, nErr);
      const pErr = validatePassword(body.password);
      if (pErr) throw new HttpError(400, pErr);
      const nickname = (body.nickname as string).normalize('NFC').trim();
      const key = nicknameKey(nickname);
      if (db.prepare('SELECT 1 FROM users WHERE nickname_key = ?').get(key)) throw new HttpError(409, 'Este apelido já está em uso.');
      const { salt, hash } = await hashPassword(body.password as string);
      let id: number;
      try {
        id = Number(db.prepare('INSERT INTO users (nickname, nickname_key, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(nickname, key, salt, hash, Date.now()).lastInsertRowid);
      } catch {
        throw new HttpError(409, 'Este apelido já está em uso.');
      }
      const token = createSession(db, id);
      return send(res, 201, { token, user: { id, nickname } });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      if (!loginLimiter.take(clientIp(req))) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
      const body = (await readJson(req)) as { nickname?: unknown; password?: unknown };
      if (typeof body.nickname !== 'string' || typeof body.password !== 'string') throw new HttpError(400, 'Informe apelido e senha.');
      const row = db.prepare('SELECT id, nickname, pass_salt, pass_hash FROM users WHERE nickname_key = ?').get(nicknameKey(body.nickname)) as
        | { id: number; nickname: string; pass_salt: string; pass_hash: string }
        | undefined;
      const ok = row ? await verifyPassword(body.password, row.pass_salt, row.pass_hash) : false;
      if (!row || !ok) throw new HttpError(401, 'Apelido ou senha incorretos.');
      const token = createSession(db, row.id);
      return send(res, 200, { token, user: { id: row.id, nickname: row.nickname } });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      deleteSession(db, req.headers.authorization);
      return send(res, 200, { ok: true });
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const user = requireUser(req);
      return send(res, 200, { user });
    }

    if (path === '/api/submissions' && method === 'POST') {
      const user = requireUser(req);
      // Lê o corpo antes de conferir os limites: daqui até o INSERT não há nenhum
      // await, então pedidos simultâneos não conseguem passar todos pela checagem.
      const body = await readJson(req);
      const pending = (db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND status IN ('aguardando', 'validando')").get(user.id) as { n: number }).n;
      if (pending >= L.maxPendingPerUser) throw new HttpError(429, `Você já tem ${pending} envios na fila. Aguarde a validação.`);
      const lastHour = (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND created_at > ?').get(user.id, Date.now() - 3600_000) as { n: number }).n;
      if (lastHour >= L.maxSubmissionsPerHour) throw new HttpError(429, `Limite de ${L.maxSubmissionsPerHour} envios por hora atingido.`);
      if (queue.pendingCount() >= L.maxQueue) throw new HttpError(503, 'A fila de validação está cheia. Tente em alguns minutos.');
      const raw = (body ?? {}) as Record<string, unknown>;
      // Só guardamos campos conhecidos. Tempos enviados pelo jogador são ignorados.
      const payload = {
        trackId: raw.trackId,
        categoryId: raw.categoryId,
        pilotName: raw.pilotName,
        rulesVersion: raw.rulesVersion,
        trackHash: raw.trackHash,
        brain: raw.brain,
      };
      const parsed = parseSubmission(payload);
      const now = Date.now();
      const trackId = typeof raw.trackId === 'string' ? raw.trackId.slice(0, 60) : '?';
      const categoryId = typeof raw.categoryId === 'string' ? raw.categoryId.slice(0, 30) : '?';
      const pilotName = parsed.ok ? parsed.pilotName : typeof raw.pilotName === 'string' ? raw.pilotName.slice(0, 40) || '?' : '?';
      const rulesV = parsed.ok ? parsed.rulesVersion : typeof raw.rulesVersion === 'string' ? raw.rulesVersion.slice(0, 40) : '?';
      const status = parsed.ok ? 'aguardando' : 'rejeitado';
      const info = db
        .prepare(
          `INSERT INTO submissions (user_id, track_id, category_id, rules_version, pilot_name, payload, status, message, created_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(user.id, trackId, categoryId, rulesV, pilotName, parsed.ok ? JSON.stringify(payload) : '{}', status, parsed.ok ? null : parsed.error, now, parsed.ok ? null : now);
      const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
      if (parsed.ok) queue.kick();
      return send(res, 202, { submission: publicSubmission(row) });
    }

    if (path === '/api/submissions' && method === 'GET') {
      const user = requireUser(req);
      const rows = db.prepare('SELECT * FROM submissions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').all(user.id) as Record<string, unknown>[];
      return send(res, 200, { submissions: rows.map(publicSubmission) });
    }

    const subMatch = /^\/api\/submissions\/(\d+)$/.exec(path);
    if (subMatch && method === 'GET') {
      const user = requireUser(req);
      const row = db.prepare('SELECT * FROM submissions WHERE id = ? AND user_id = ?').get(Number(subMatch[1]), user.id) as Record<string, unknown> | undefined;
      if (!row) throw new HttpError(404, 'Envio não encontrado.');
      return send(res, 200, { submission: publicSubmission(row) });
    }

    throw new HttpError(404, 'Rota não encontrada.');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (!staticRoot || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return false; // URL malformada: 404
    }
    if (rel.includes(' ')) return false;
    if (rel.endsWith('/')) rel += 'index.html';
    let file = resolve(staticRoot, '.' + rel);
    const inside = relative(staticRoot, file);
    if (inside.startsWith('..') || isAbsolute(inside)) return false;
    if (!existsSync(file) || !statSync(file).isFile()) file = join(staticRoot, 'index.html'); // SPA
    if (!existsSync(file)) return false;
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = file.includes(`${join(staticRoot, 'assets')}`);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    return true;
  }

  return createServer((req, res) => {
    try {
      route(req, res);
    } catch (e) {
      console.error('[http] erro inesperado', e);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Pedido inválido');
      }
    }
  });

  function route(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Pedido inválido');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', cors);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      handleApi(req, res, url).catch((e: unknown) => {
        if (res.headersSent) return;
        if (e instanceof HttpError) send(res, e.status, { error: e.message });
        else {
          console.error('[api] erro inesperado', e);
          send(res, 500, { error: 'Erro interno. Tente novamente.' });
        }
      });
      return;
    }
    if (!serveStatic(req, res, url)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
    }
  }
}
