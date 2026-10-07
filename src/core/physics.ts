import { clamp, dsincos, dtan, PI, TWO_PI } from './dmath.ts';

/**
 * Física 2D do carro: modelo cinemático de bicicleta simplificado.
 *
 * - O esterçamento máximo diminui com a velocidade.
 * - A curvatura possível é limitada pela aderência lateral (v²·κ ≤ aLatMax):
 *   acima disso o carro "sai de frente" (faz uma curva mais aberta que a pedida)
 *   e perde velocidade por arrasto dos pneus. Assim, curvas fechadas exigem frear.
 * - Comandos chegam aos poucos (volante e pedais têm taxa máxima de variação).
 * - Freio tem prioridade: quando o freio passa de 50%, o acelerador é ignorado.
 */
export const PHYSICS = Object.freeze({
  version: 1,
  dt: 1 / 60,
  /** Dimensões do corpo (metros). Desenho, colisão e sensores usam os mesmos valores. */
  carLength: 4.6,
  carWidth: 1.9,
  wheelbase: 2.9,
  /** Velocidade de referência para o limite de motor (m/s). Velocidade final real ≈ 61 m/s. */
  engineSpeed: 72,
  accel: 13,
  brake: 32,
  rollDrag: 0.6,
  airDrag: 0.0004,
  maxSteer: 0.55,
  steerSpeedRef: 22,
  steerRate: 2.6,
  pedalRate: 7,
  maxLatAccel: 24,
  scrubDecel: 7,
  /** Velocidade usada para normalizar a entrada de velocidade da rede. */
  speedNorm: 65,
  /** Limiar do freio: abaixo disso o freio não atua. */
  brakeThreshold: 0.5,
});

export interface CarPhysics {
  x: number;
  y: number;
  heading: number;
  speed: number;
  /** Ângulo real das rodas (rad) */
  steer: number;
  throttle: number;
  brake: number;
  /** Aceleração lateral atual (m/s²), útil para som e interface */
  latAccel: number;
  /** true quando o carro pede mais curva do que a aderência permite */
  sliding: boolean;
}

export function makeCarPhysics(x: number, y: number, heading: number): CarPhysics {
  return { x, y, heading, speed: 0, steer: 0, throttle: 0, brake: 0, latAccel: 0, sliding: false };
}

const sc = { s: 0, c: 0 };

/**
 * Avança a física um passo fixo.
 * @param steerCmd  −1..1 (esquerda/direita relativo ao carro)
 * @param throttleCmd 0..1
 * @param brakeCmd 0..1
 */
export function stepPhysics(car: CarPhysics, steerCmd: number, throttleCmd: number, brakeCmd: number, dt: number): void {
  const P = PHYSICS;
  steerCmd = clamp(steerCmd, -1, 1);
  throttleCmd = clamp(throttleCmd, 0, 1);
  brakeCmd = clamp(brakeCmd, 0, 1);

  // Freio com prioridade sobre o acelerador.
  let brakeTarget = 0;
  let throttleTarget = throttleCmd;
  if (brakeCmd > P.brakeThreshold) {
    brakeTarget = (brakeCmd - P.brakeThreshold) / (1 - P.brakeThreshold);
    throttleTarget = 0;
  }

  // Pedais e volante respondem gradualmente.
  const pedalStep = P.pedalRate * dt;
  car.throttle += clamp(throttleTarget - car.throttle, -pedalStep, pedalStep);
  car.brake += clamp(brakeTarget - car.brake, -pedalStep, pedalStep);

  const v = car.speed;
  const steerLimit = P.maxSteer / (1 + v / P.steerSpeedRef);
  const steerTarget = steerCmd * steerLimit;
  const steerStep = P.steerRate * dt;
  car.steer += clamp(steerTarget - car.steer, -steerStep, steerStep);
  car.steer = clamp(car.steer, -P.maxSteer, P.maxSteer);

  // Curvatura pedida e limite de aderência.
  const kCmd = dtan(car.steer) / P.wheelbase;
  let k = kCmd;
  let scrub = 0;
  car.sliding = false;
  if (v > 0.5) {
    const kMax = P.maxLatAccel / (v * v);
    const ak = kCmd < 0 ? -kCmd : kCmd;
    if (ak > kMax) {
      k = kCmd < 0 ? -kMax : kMax;
      scrub = P.scrubDecel * Math.min(1, ak / kMax - 1);
      car.sliding = true;
    }
  }
  const lat = v * v * (k < 0 ? -k : k);
  car.latAccel = lat;

  // Longitudinal.
  let a = car.throttle * P.accel * (1 - v / P.engineSpeed);
  if (v > 0) {
    a -= car.brake * P.brake + P.rollDrag + P.airDrag * v * v + scrub + 0.02 * lat;
  }
  let nv = v + a * dt;
  if (nv < 0) nv = 0;
  car.speed = nv;

  // Integração semi-implícita: usa a nova velocidade.
  car.heading += nv * k * dt;
  if (car.heading > PI) car.heading -= TWO_PI;
  else if (car.heading <= -PI) car.heading += TWO_PI;
  dsincos(car.heading, sc);
  car.x += nv * sc.c * dt;
  car.y += nv * sc.s * dt;
}

/** Quatro cantos do corpo do carro (sentido horário) em `out` [x0,y0,...,x3,y3]. */
export function carCorners(x: number, y: number, heading: number, out: Float64Array): void {
  dsincos(heading, sc);
  const c = sc.c;
  const s = sc.s;
  const hl = PHYSICS.carLength / 2;
  const hw = PHYSICS.carWidth / 2;
  // frente-esquerda, frente-direita, trás-direita, trás-esquerda (no referencial do carro, +x à frente, +y à esquerda... em tela y cresce para baixo)
  const fx = c * hl;
  const fy = s * hl;
  const sx = -s * hw;
  const sy = c * hw;
  out[0] = x + fx + sx;
  out[1] = y + fy + sy;
  out[2] = x + fx - sx;
  out[3] = y + fy - sy;
  out[4] = x - fx - sx;
  out[5] = y - fy - sy;
  out[6] = x - fx + sx;
  out[7] = y - fy + sy;
}
