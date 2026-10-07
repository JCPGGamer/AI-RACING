import { dsincos } from './dmath.ts';
import { queryBox, raycast, segSegT } from './geometry.ts';
import { archKey, NetRunner, type Brain } from './nn.ts';
import { carCorners, makeCarPhysics, PHYSICS, stepPhysics, type CarPhysics } from './physics.ts';
import { ReplayRecorder, REPLAY_EVERY } from './replay.ts';
import type { AttemptStats } from './rewards.ts';
import { inputCount, LOOKAHEAD_DIST, RAY_RANGE, rayDirs, type InputConfig } from './sensors.ts';
import { projectLocal, START_OFFSET, type Projection, type Track } from './track.ts';

/**
 * Simulação de uma tentativa para vários carros na mesma pista.
 * Carros não colidem entre si. Cada passo:
 *   sensores → rede → física → colisão → progresso/checkpoints → encerramento.
 */

export type EndReason = 'correndo' | 'batida' | 'completou' | 'tempo' | 'parado';

export const END_REASON_LABEL: Record<EndReason, string> = {
  correndo: 'Correndo',
  batida: 'Bateu na borda',
  completou: 'Completou a volta',
  tempo: 'Tempo esgotado',
  parado: 'Sem progresso',
};

export interface RunRules {
  /** Tempo máximo da tentativa (s simulados) */
  maxTime: number;
  /** Encerra se não avançar stallDist metros em stallTime segundos */
  stallTime: number;
  stallDist: number;
}

export interface StartCondition {
  /** Deslocamento lateral na largada (m, positivo para o lado A) */
  lateral: number;
  /** Desvio do ângulo de largada (rad) */
  heading: number;
}

export const STANDARD_START: StartCondition = Object.freeze({ lateral: 0, heading: 0 });

/**
 * Controle externo (teclado no modo de teste manual, ou roteiros nos testes).
 * Escreve direção/acelerador/freio em `out` no lugar da rede neural.
 */
export type Controller = (car: CarRun, out: Float64Array, sim: RaceSim) => void;

/** Janela de busca da projeção na linha central (amostras para cada lado). */
const PROJ_WINDOW = 8;

export class CarRun {
  readonly brain: Brain;
  readonly net: NetRunner;
  readonly phys: CarPhysics;
  readonly input: Float64Array;
  readonly output = new Float64Array(3);
  /** Distâncias atuais dos sensores em metros (para visualização) */
  readonly rays: Float64Array;
  readonly proj: Projection = { seg: 0, s: 0, lateral: 0, dist: 0 };

  /** s atual na pista em [0, L) */
  sMod = 0;
  /** progresso acumulado desde a largada (pode ficar negativo andando para trás) */
  progress = 0;
  maxProgress = 0;
  timeAtMax = 0;
  nextCp = 1;
  cpPassed = 0;
  steps = 0;
  status: EndReason = 'correndo';
  endTime = 0;
  lapTime = NaN;
  backDist = 0;
  steerVar = 0;
  prevSteerCmd = 0;
  stallStart = 0;
  stallRef = 0;
  crashX = NaN;
  crashY = NaN;
  recorder: ReplayRecorder | null = null;
  controller: Controller | null = null;

  constructor(brain: Brain, net: NetRunner, x: number, y: number, heading: number) {
    this.brain = brain;
    this.net = net;
    this.phys = makeCarPhysics(x, y, heading);
    this.input = new Float64Array(inputCount(brain.inputs));
    this.rays = new Float64Array(brain.inputs.rays);
  }

  get alive(): boolean {
    return this.status === 'correndo';
  }

  get time(): number {
    return this.status === 'correndo' ? this.steps * PHYSICS.dt : this.endTime;
  }
}

export interface SimEvent {
  type: 'batida' | 'volta';
  car: number;
  x: number;
  y: number;
}

const sc = { s: 0, c: 0 };
const oldC = new Float64Array(8);
const newC = new Float64Array(8);
const cand = new Int32Array(512);
const HALF_DIAG = Math.sqrt((PHYSICS.carLength / 2) * (PHYSICS.carLength / 2) + (PHYSICS.carWidth / 2) * (PHYSICS.carWidth / 2));

export class RaceSim {
  /** Desliga o atalho de colisão (usado nos testes para provar que ele é exato). */
  static alwaysTestCollision = false;
  readonly track: Track;
  readonly rules: RunRules;
  readonly cars: CarRun[];
  readonly dt = PHYSICS.dt;
  step = 0;
  alive = 0;
  /** Eventos do último passo (batidas e voltas) */
  events: SimEvent[] = [];
  /** Soma de carros simulados por passo (medida de trabalho/orçamento) */
  carSteps = 0;

  constructor(track: Track, brains: Brain[], rules: RunRules, starts: StartCondition | StartCondition[] = STANDARD_START, record: boolean | boolean[] = false) {
    this.track = track;
    this.rules = rules;
    const nets = new Map<string, NetRunner>();
    this.cars = brains.map((b, i) => {
      const key = archKey(b.inputs, b.hidden);
      let net = nets.get(key);
      if (!net) {
        net = new NetRunner(b.inputs, b.hidden);
        nets.set(key, net);
      }
      const st = Array.isArray(starts) ? starts[i] ?? STANDARD_START : starts;
      const si = track.start.sample;
      const x = track.start.x + track.nx[si] * st.lateral;
      const y = track.start.y + track.ny[si] * st.lateral;
      const car = new CarRun(b, net, x, y, track.start.heading + st.heading);
      projectLocal(track, x, y, si, PROJ_WINDOW, car.proj);
      car.sMod = car.proj.s;
      const rec = Array.isArray(record) ? record[i] : record;
      if (rec) {
        car.recorder = new ReplayRecorder(Math.ceil(rules.maxTime / (PHYSICS.dt * REPLAY_EVERY)) + 4);
        car.recorder.push(x, y, car.phys.heading, 0, 0, 0, 0);
      }
      return car;
    });
    this.alive = this.cars.length;
    for (const car of this.cars) this.computeInputs(car);
  }

  get done(): boolean {
    return this.alive === 0;
  }

  /** Avança todos os carros vivos um passo fixo. */
  stepAll(): void {
    this.events.length = 0;
    if (this.alive === 0) return;
    this.step++;
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (car.status !== 'correndo') continue;
      this.stepCar(car, i);
    }
  }

  private stepCar(car: CarRun, index: number): void {
    const track = this.track;
    const P = car.phys;
    const dt = this.dt;
    this.carSteps++;

    // 1) Rede decide com as entradas calculadas no fim do passo anterior.
    if (car.controller) car.controller(car, car.output, this);
    else car.net.run(car.brain.genome, car.input, car.output);
    const steerCmd = car.output[0];
    const thr = car.output[1];
    const brk = car.output[2];
    const ds = steerCmd - car.prevSteerCmd;
    car.steerVar += ds < 0 ? -ds : ds;
    car.prevSteerCmd = steerCmd;

    // 2) Física
    const ox = P.x;
    const oy = P.y;
    const oh = P.heading;
    stepPhysics(P, steerCmd, thr, brk, dt);
    car.steps++;
    const t = car.steps * dt;

    // 3) Colisão do corpo inteiro (arestas na nova pose + trajetória de cada canto).
    // Atalho exato: se o centro estava longe das bordas (projeção do passo anterior),
    // nenhum ponto do corpo consegue alcançá-las neste passo — não precisa testar.
    const lat = car.proj.lateral < 0 ? -car.proj.lateral : car.proj.lateral;
    if ((RaceSim.alwaysTestCollision || lat + P.speed * dt + HALF_DIAG >= track.safeHw[car.proj.seg]) && this.collides(car, index, t, ox, oy, oh)) return;

    // 4) Progresso ao longo da pista (projeção local, sem confundir trechos vizinhos).
    projectLocal(track, P.x, P.y, car.proj.seg, PROJ_WINDOW, car.proj);
    let dS = car.proj.s - car.sMod;
    const L = track.length;
    if (dS > L / 2) dS -= L;
    else if (dS < -L / 2) dS += L;
    car.sMod = car.proj.s;
    car.progress += dS;
    if (dS < 0) car.backDist -= dS;

    // 5) Checkpoints: só o próximo da ordem, cruzado pelo segmento percorrido e no sentido certo.
    const cps = track.checkpoints;
    const cpIdx = car.nextCp === cps.length ? 0 : car.nextCp;
    const cp = cps[cpIdx];
    const cross = segSegT(ox, oy, P.x, P.y, cp.ax, cp.ay, cp.bx, cp.by);
    if (cross >= 0 && (P.x - ox) * cp.tx + (P.y - oy) * cp.ty > 0) {
      car.cpPassed++;
      if (cpIdx === 0) {
        // Chegada válida: todos os checkpoints na ordem + linha cruzada no sentido certo.
        car.maxProgress = track.lapDistance;
        car.lapTime = (car.steps - 1 + cross) * dt;
        car.timeAtMax = car.lapTime;
        this.finishRecord(car);
        car.status = 'completou';
        car.endTime = car.lapTime;
        this.alive--;
        this.events.push({ type: 'volta', car: index, x: P.x, y: P.y });
        return;
      }
      car.nextCp++;
    }

    // Progresso máximo: só conta trecho novo e nunca passa do próximo checkpoint não cruzado.
    const nextS = car.nextCp === cps.length ? track.lapDistance : cps[car.nextCp].s - START_OFFSET;
    const capped = car.progress < nextS + 0.5 ? car.progress : nextS + 0.5;
    if (capped > car.maxProgress) {
      car.maxProgress = capped;
      car.timeAtMax = t;
    }

    // 6) Encerramentos por tempo e falta de progresso.
    if (car.maxProgress >= car.stallRef + this.rules.stallDist) {
      car.stallRef = car.maxProgress;
      car.stallStart = t;
    } else if (t - car.stallStart >= this.rules.stallTime) {
      this.kill(car, index, 'parado', t, NaN, NaN);
      return;
    }
    if (t >= this.rules.maxTime - 1e-9) {
      this.kill(car, index, 'tempo', t, NaN, NaN);
      return;
    }

    if (car.recorder && car.steps % REPLAY_EVERY === 0) {
      car.recorder.push(P.x, P.y, P.heading, P.speed, steerCmd, thr, brk);
    }
    // Entradas para o próximo passo.
    this.computeInputs(car);
  }

  /** Testa colisão do corpo contra as bordas; se bater, encerra a tentativa. */
  private collides(car: CarRun, index: number, t: number, ox: number, oy: number, oh: number): boolean {
    const P = car.phys;
    carCorners(ox, oy, oh, oldC);
    carCorners(P.x, P.y, P.heading, newC);
    let minX = oldC[0],
      maxX = oldC[0],
      minY = oldC[1],
      maxY = oldC[1];
    for (let k = 0; k < 8; k += 2) {
      const a = oldC[k],
        b = newC[k],
        c = oldC[k + 1],
        d = newC[k + 1];
      if (a < minX) minX = a;
      if (a > maxX) maxX = a;
      if (b < minX) minX = b;
      if (b > maxX) maxX = b;
      if (c < minY) minY = c;
      if (c > maxY) maxY = c;
      if (d < minY) minY = d;
      if (d > maxY) maxY = d;
    }
    const g = this.track.grid;
    const n = queryBox(g, minX, minY, maxX, maxY, cand);
    const segs = g.segs;
    for (let q = 0; q < n; q++) {
      const o = cand[q] * 4;
      const sx1 = segs[o],
        sy1 = segs[o + 1],
        sx2 = segs[o + 2],
        sy2 = segs[o + 3];
      for (let k = 0; k < 8; k += 2) {
        const k2 = (k + 2) & 7;
        // aresta do corpo na nova posição
        let tt = segSegT(newC[k], newC[k + 1], newC[k2], newC[k2 + 1], sx1, sy1, sx2, sy2);
        if (tt >= 0) {
          this.kill(car, index, 'batida', t, newC[k] + (newC[k2] - newC[k]) * tt, newC[k + 1] + (newC[k2 + 1] - newC[k + 1]) * tt);
          return true;
        }
        // varredura do canto entre os passos (evita atravessar bordas)
        tt = segSegT(oldC[k], oldC[k + 1], newC[k], newC[k + 1], sx1, sy1, sx2, sy2);
        if (tt >= 0) {
          this.kill(car, index, 'batida', t, oldC[k] + (newC[k] - oldC[k]) * tt, oldC[k + 1] + (newC[k + 1] - oldC[k + 1]) * tt);
          return true;
        }
      }
    }

    return false;
  }

  private finishRecord(car: CarRun): void {
    if (car.recorder) {
      const P = car.phys;
      car.recorder.push(P.x, P.y, P.heading, P.speed, car.output[0], car.output[1], car.output[2]);
    }
  }

  private kill(car: CarRun, index: number, reason: EndReason, t: number, cx: number, cy: number): void {
    car.status = reason;
    car.endTime = t;
    this.alive--;
    if (reason === 'batida') {
      car.crashX = cx;
      car.crashY = cy;
      car.phys.speed = 0;
      this.events.push({ type: 'batida', car: index, x: cx, y: cy });
    }
    this.finishRecord(car);
  }

  /** Calcula as entradas da rede a partir da pose atual. */
  computeInputs(car: CarRun): void {
    const cfg: InputConfig = car.brain.inputs;
    const P = car.phys;
    const track = this.track;
    const buf = car.input;
    dsincos(P.heading, sc);
    const hc = sc.c;
    const hs = sc.s;
    const dirs = rayDirs(cfg.rays);
    let k = 0;
    for (let r = 0; r < cfg.rays; r++) {
      const ca = dirs.cos[r];
      const sa = dirs.sin[r];
      const dx = hc * ca - hs * sa;
      const dy = hs * ca + hc * sa;
      const d = raycast(track.grid, P.x, P.y, dx, dy, RAY_RANGE);
      car.rays[r] = d;
      buf[k++] = d / RAY_RANGE;
    }
    if (cfg.speed) {
      const v = P.speed / PHYSICS.speedNorm;
      buf[k++] = v > 1 ? 1 : v;
    }
    if (cfg.prevSteer) buf[k++] = car.prevSteerCmd;
    const seg = car.proj.seg;
    if (cfg.trackAngle) {
      const tx = track.tx[seg];
      const ty = track.ty[seg];
      buf[k++] = tx * hs - ty * hc;
      buf[k++] = tx * hc + ty * hs;
    }
    if (cfg.lateral) {
      const hw = track.hw[seg];
      const l = car.proj.lateral / hw;
      buf[k++] = l > 1 ? 1 : l < -1 ? -1 : l;
    }
    if (cfg.lookahead) {
      const N = track.n;
      for (let q = 0; q < LOOKAHEAD_DIST.length; q++) {
        const s = car.proj.s + LOOKAHEAD_DIST[q];
        const f = s / track.spacing;
        const fi = Math.floor(f);
        const i = fi % N;
        const j = (i + 1) % N;
        const u = f - fi;
        const px = track.cx[i] + (track.cx[j] - track.cx[i]) * u - P.x;
        const py = track.cy[i] + (track.cy[j] - track.cy[i]) * u - P.y;
        const len = Math.sqrt(px * px + py * py) || 1;
        const fwd = (px * hc + py * hs) / len;
        const side = (py * hc - px * hs) / len;
        buf[k++] = side;
        buf[k++] = fwd;
      }
    }
  }

  /** Estatísticas da tentativa do carro i para a pontuação de treinamento. */
  statsOf(i: number): AttemptStats {
    const car = this.cars[i];
    return {
      maxProgress: Math.max(0, car.maxProgress),
      lapDistance: this.track.lapDistance,
      checkpoints: car.cpPassed,
      checkpointTotal: this.track.checkpoints.length,
      completed: car.status === 'completou',
      crashed: car.status === 'batida',
      stalled: car.status === 'parado',
      time: car.time,
      maxTime: this.rules.maxTime,
      backDistance: car.backDist,
      steerVariation: car.steerVar,
      refTime: this.track.refTime,
    };
  }

  /** Executa até todos terminarem (com limite de passos de segurança). */
  runToEnd(maxSteps = Infinity): void {
    let guard = 0;
    while (this.alive > 0 && guard++ < maxSteps) this.stepAll();
  }
}
