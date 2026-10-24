import { createHash, createHmac, randomBytes } from 'crypto';

// Pure game maths: no I/O, no config. Unit-tested in tests/game.test.ts.
export const HOUSE_EDGE = 0.01; // P(crash >= x) = 0.99 / x
export const GROWTH_PER_SECOND = 0.1; // multiplier = e^(0.1 * seconds)
export const MAX_CRASH = 1000;

export function createSeed(): string {
  if (process.env.NODE_ENV === 'test' && process.env.TEST_FORCE_SEED) return process.env.TEST_FORCE_SEED;
  return randomBytes(32).toString('hex');
}

export function seedHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

/** Deterministic crash point (2 decimals, >= 1.00) derived from the server seed. */
export function crashPointFromSeed(seed: string): number {
  const h = createHmac('sha256', seed).update('aviator-v1').digest();
  const r = h.readUIntBE(0, 6) / 2 ** 48; // uniform in [0,1)
  const raw = Math.floor((100 * (1 - HOUSE_EDGE)) / (1 - r));
  return Math.min(MAX_CRASH, Math.max(100, raw) / 100);
}

export function multiplierAt(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  return Math.floor(100 * Math.exp(GROWTH_PER_SECOND * t)) / 100;
}

/** Milliseconds after round start at which the plane flies away. */
export function crashTimeMs(crashPoint: number): number {
  return (Math.log(crashPoint) / GROWTH_PER_SECOND) * 1000;
}

export function payoutFor(bet: number, multiplier: number): number {
  return Math.floor(bet * multiplier);
}
