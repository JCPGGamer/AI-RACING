/**
 * Matemática determinística.
 *
 * Math.sin/cos/exp/log/tanh podem variar no último bit entre motores JavaScript
 * (V8, SpiderMonkey, JavaScriptCore). A simulação oficial roda no servidor e no
 * navegador, então usamos apenas + − × ÷ e Math.sqrt (que o IEEE-754 exige
 * arredondar corretamente). Assim o mesmo cérebro produz o mesmo tempo em
 * qualquer navegador e no servidor.
 */

export const PI = 3.141592653589793;
export const TWO_PI = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

// π/2 dividido em duas partes para redução de argumento precisa (Cody–Waite).
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
const TWO_OVER_PI = 0.6366197723675814;

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;
const LN2 = 0.6931471805599453;

function sinKernel(x: number): number {
  const z = x * x;
  // Série de Taylor até x^15 (erro < 1e-17 em |x| ≤ π/4)
  return (
    x *
    (1 +
      z *
        (-1 / 6 +
          z *
            (1 / 120 +
              z *
                (-1 / 5040 +
                  z * (1 / 362880 + z * (-1 / 39916800 + z * (1 / 6227020800 + z * (-1 / 1307674368000))))))))
  );
}

function cosKernel(x: number): number {
  const z = x * x;
  return (
    1 +
    z *
      (-1 / 2 +
        z *
          (1 / 24 +
            z *
              (-1 / 720 +
                z * (1 / 40320 + z * (-1 / 3628800 + z * (1 / 479001600 + z * (-1 / 87178291200 + z * (1 / 20922789888000))))))))
  );
}

export function dsin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  switch (((k % 4) + 4) % 4) {
    case 0:
      return sinKernel(r);
    case 1:
      return cosKernel(r);
    case 2:
      return -sinKernel(r);
    default:
      return -cosKernel(r);
  }
}

export function dcos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  switch (((k % 4) + 4) % 4) {
    case 0:
      return cosKernel(r);
    case 1:
      return -sinKernel(r);
    case 2:
      return -cosKernel(r);
    default:
      return sinKernel(r);
  }
}

/** Seno e cosseno juntos (evita reduzir o argumento duas vezes). */
export function dsincos(x: number, out: { s: number; c: number }): void {
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  const s = sinKernel(r);
  const c = cosKernel(r);
  switch (((k % 4) + 4) % 4) {
    case 0:
      out.s = s;
      out.c = c;
      break;
    case 1:
      out.s = c;
      out.c = -s;
      break;
    case 2:
      out.s = -s;
      out.c = -c;
      break;
    default:
      out.s = -c;
      out.c = s;
  }
}

export function dtan(x: number): number {
  return dsin(x) / dcos(x);
}

// Potências de 2 exatas (multiplicar por 2 é exato em ponto flutuante).
const POW2_MIN = -1022;
const POW2_MAX = 1023;
const POW2 = new Float64Array(POW2_MAX - POW2_MIN + 1);
{
  let v = 1;
  for (let k = 0; k <= POW2_MAX; k++) {
    POW2[k - POW2_MIN] = v;
    v *= 2;
  }
  v = 1;
  for (let k = 0; k >= POW2_MIN; k--) {
    POW2[k - POW2_MIN] = v;
    v /= 2;
  }
}

/** 2^(j/64) para j = 0..63, arredondados corretamente (literais exatos em qualquer motor). */
const EXP_TABLE = new Float64Array([
  1.0,
  1.0108892860517005,
  1.0218971486541166,
  1.0330248790212284,
  1.0442737824274138,
  1.0556451783605572,
  1.0671404006768237,
  1.0787607977571199,
  1.0905077326652577,
  1.102382583307841,
  1.1143867425958924,
  1.1265216186082418,
  1.1387886347566916,
  1.1511892299529827,
  1.1637248587775775,
  1.1763969916502812,
  1.189207115002721,
  1.202156731452703,
  1.215247359980469,
  1.22848053610687,
  1.241857812073484,
  1.255380757024691,
  1.2690509571917332,
  1.2828700160787783,
  1.2968395546510096,
  1.3109612115247644,
  1.3252366431597413,
  1.339667524053303,
  1.3542555469368927,
  1.3690024229745905,
  1.383909881963832,
  1.3989796725383112,
  1.4142135623730951,
  1.42961333839197,
  1.4451808069770467,
  1.460917794180647,
  1.4768261459394993,
  1.4929077282912648,
  1.5091644275934228,
  1.5255981507445384,
  1.5422108254079407,
  1.559004400237837,
  1.5759808451078865,
  1.593142151342267,
  1.6104903319492543,
  1.6280274218573478,
  1.645755478153965,
  1.6636765803267364,
  1.681792830507429,
  1.7001063537185235,
  1.718619298122478,
  1.7373338352737062,
  1.7562521603732995,
  1.7753764925265212,
  1.7947090750031072,
  1.8142521755003989,
  1.8340080864093424,
  1.8539791250833855,
  1.8741676341103,
  1.8945759815869656,
  1.9152065613971474,
  1.9360617934922943,
  1.9571441241754002,
  1.978456026387951
]);
const LN2_64_HI = LN2_HI / 64;
const LN2_64_LO = LN2_LO / 64;
const INV_LN2_64 = INV_LN2 * 64;

/**
 * Exponencial determinística: redução x = (64·m + j)·ln2/64 + r com |r| ≤ ln2/128,
 * tabela exata de 2^(j/64) e polinômio curto em r. Erro relativo < 2e-16.
 */
export function dexp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 709) return Infinity;
  if (x < -708) return 0;
  const k = Math.round(x * INV_LN2_64);
  const r = x - k * LN2_64_HI - k * LN2_64_LO;
  const m = Math.floor(k / 64);
  const j = k - m * 64;
  const p = 1 + r * (1 + r * (0.5 + r * (1 / 6 + r * (1 / 24 + r * (1 / 120 + r * (1 / 720))))));
  return POW2[m - POW2_MIN] * (EXP_TABLE[j] * p);
}

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE_ENDIAN ? 1 : 0;

export function dlog(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  // Separa mantissa e expoente pelos bits (operação exata).
  let e = 0;
  if (x < 2.2250738585072014e-308) {
    x *= 18014398509481984; // 2^54 para normalizar subnormais
    e -= 54;
  }
  F64[0] = x;
  const hi = U32[HI];
  e += ((hi >>> 20) & 0x7ff) - 1023;
  U32[HI] = (hi & 0x000fffff) | 0x3ff00000; // mantissa em [1, 2)
  let m = F64[0];
  if (m > 1.4142135623730951) {
    m *= 0.5;
    e += 1;
  }
  const s = (m - 1) / (m + 1);
  const z = s * s;
  let p = 1 / 23;
  p = 1 / 21 + z * p;
  p = 1 / 19 + z * p;
  p = 1 / 17 + z * p;
  p = 1 / 15 + z * p;
  p = 1 / 13 + z * p;
  p = 1 / 11 + z * p;
  p = 1 / 9 + z * p;
  p = 1 / 7 + z * p;
  p = 1 / 5 + z * p;
  p = 1 / 3 + z * p;
  p = 1 + z * p;
  return 2 * s * p + e * LN2;
}

export function dtanh(x: number): number {
  if (x > 19) return 1;
  if (x < -19) return -1;
  if (x > -1e-5 && x < 1e-5) return x;
  const e = dexp(2 * x);
  return (e - 1) / (e + 1);
}

export function dsigmoid(x: number): number {
  if (x > 40) return 1;
  if (x < -40) return 0;
  return 1 / (1 + dexp(-x));
}

/** Arco-tangente determinística (usada só em ferramentas, não no laço quente). */
export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const swap = ay > ax;
  const t = swap ? ax / ay : ay / ax; // t em [0, 1]
  // Identidade do ângulo metade: atan(t) = 2·atan(t / (1 + sqrt(1 + t²))), com t2 ≤ tan(π/8)
  const t2 = t / (1 + Math.sqrt(1 + t * t));
  const z = t2 * t2;
  let sum = 0;
  let term = t2;
  for (let n = 0; n < 24; n++) {
    sum += (n % 2 === 0 ? 1 : -1) * (term / (2 * n + 1));
    term *= z;
  }
  let a = 2 * sum;
  if (swap) a = HALF_PI - a;
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

/** Normaliza um ângulo para (−π, π]. */
export function wrapAngle(a: number): number {
  while (a > PI) a -= TWO_PI;
  while (a <= -PI) a += TWO_PI;
  return a;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function deg(d: number): number {
  return (d * PI) / 180;
}
