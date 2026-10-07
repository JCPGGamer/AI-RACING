import { getBuiltinTrack } from '../src/core/builtinTracks.ts';
import { datan2, wrapAngle } from '../src/core/dmath.ts';
import { randomGenome, type Brain } from '../src/core/nn.ts';
import { PHYSICS } from '../src/core/physics.ts';
import { Rng } from '../src/core/rng.ts';
import { DEFAULT_INPUTS } from '../src/core/sensors.ts';
import type { Controller } from '../src/core/sim.ts';
import { buildTrack, pointAtS, type Track } from '../src/core/track.ts';

export function track(id = 'oval-largo'): Track {
  return buildTrack(getBuiltinTrack(id)!);
}

export function randomBrain(seed = 1): Brain {
  return { inputs: { ...DEFAULT_INPUTS }, hidden: [16, 16], genome: randomGenome(DEFAULT_INPUTS, [16, 16], new Rng(seed)) };
}

/** Piloto roteirizado que segue a linha central pela física real (perseguição pura). */
export function followCenter(targetSpeed: number, lookahead = 9): Controller {
  return (car, out, sim) => {
    const P = car.phys;
    const tgt = pointAtS(sim.track, car.proj.s + lookahead);
    const ang = wrapAngle(datan2(tgt.y - P.y, tgt.x - P.x) - P.heading);
    const limit = PHYSICS.maxSteer / (1 + P.speed / PHYSICS.steerSpeedRef);
    out[0] = Math.max(-1, Math.min(1, (ang * 2.2) / limit));
    out[1] = P.speed < targetSpeed ? 1 : 0;
    out[2] = P.speed > targetSpeed + 3 ? 1 : 0;
  };
}

/**
 * Controle "cinemático" para testes: aponta o carro diretamente e fixa a
 * velocidade. Permite ir para frente e para trás com precisão.
 */
export function kinematic(plan: (step: number, car: Parameters<Controller>[0], sim: Parameters<Controller>[2]) => { forward: boolean; speed: number }): Controller {
  let step = 0;
  return (car, out, sim) => {
    const P = car.phys;
    const { forward, speed } = plan(step++, car, sim);
    const t = pointAtS(sim.track, car.proj.s + (forward ? 6 : -6));
    P.heading = datan2(t.y - P.y, t.x - P.x);
    P.speed = speed;
    P.steer = 0;
    P.throttle = 0;
    P.brake = 0;
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
  };
}
