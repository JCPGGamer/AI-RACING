import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';
import { ValidationQueue } from './queue.ts';

/**
 * Servidor do ranking público do EvoRace.
 *
 * Variáveis de ambiente:
 *   PORT          porta HTTP (padrão 8787)
 *   HOST          interface (padrão 0.0.0.0)
 *   DB_PATH       arquivo SQLite (padrão ./data/evorace.db)
 *   CORS_ORIGIN   origem permitida para a API (padrão *)
 *   STATIC_DIR    pasta do jogo compilado (padrão ./dist; servida se existir)
 *   TRUST_PROXY   "1" para usar X-Forwarded-For nos limites por IP
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const dbPath = process.env.DB_PATH ?? join(root, 'data', 'evorace.db');
const staticDir = process.env.STATIC_DIR ?? join(root, 'dist');

const db = openDatabase(dbPath);
const queue = new ValidationQueue(db, {
  onResult: (id, status) => console.log(`[validação] envio ${id}: ${status}`),
});
const server = createApp({
  db,
  queue,
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  staticDir,
  trustProxy: process.env.TRUST_PROXY === '1',
});
queue.start();
server.listen(port, host, () => {
  console.log(`EvoRace — ranking em http://localhost:${port} (banco: ${dbPath})`);
});

const shutdown = () => {
  queue.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
