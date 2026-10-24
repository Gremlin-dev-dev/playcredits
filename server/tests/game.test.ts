import { describe, expect, it } from 'vitest';
import { crashPointFromSeed, crashTimeMs, multiplierAt, payoutFor, seedHash } from '../src/game';
import { betSchema, credentialsSchema } from '../src/validation';

describe('game maths', () => {
  it('derives a deterministic crash point >= 1.00', () => {
    expect(crashPointFromSeed('abc')).toBe(crashPointFromSeed('abc'));
    for (let i = 0; i < 2000; i++) expect(crashPointFromSeed('seed' + i)).toBeGreaterThanOrEqual(1);
  });
  it('matches the 1% house edge distribution: P(crash >= 2) ~ 0.495', () => {
    let hits = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) if (crashPointFromSeed('s' + i) >= 2) hits++;
    expect(hits / n).toBeGreaterThan(0.48);
    expect(hits / n).toBeLessThan(0.51);
  });
  it('multiplier starts at 1.00 and grows', () => {
    expect(multiplierAt(0)).toBe(1);
    expect(multiplierAt(10_000)).toBeCloseTo(2.71, 1);
    expect(multiplierAt(20_000)).toBeGreaterThan(multiplierAt(10_000));
  });
  it('crash time is consistent with the multiplier curve', () => {
    expect(crashTimeMs(1)).toBe(0);
    expect(multiplierAt(crashTimeMs(2) + 1)).toBeGreaterThanOrEqual(2);
  });
  it('payout rounds down to whole credits', () => {
    expect(payoutFor(2000, 3)).toBe(6000);
    expect(payoutFor(333, 1.5)).toBe(499);
  });
  it('seed hash is sha256 hex', () => {
    expect(seedHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('validation', () => {
  const bet = betSchema(100, 5000);
  it('accepts a valid bet', () => expect(bet.parse({ amount: 2000 }).amount).toBe(2000));
  it.each([{ amount: 99 }, { amount: 5001 }, { amount: 100.5 }, { amount: '500' }, { amount: -5 }, {}])('rejects %j', (b) => {
    expect(bet.safeParse(b).success).toBe(false);
  });
  it('requires a valid email and a 10+ char password', () => {
    expect(credentialsSchema.safeParse({ email: 'nope', password: 'longenough1' }).success).toBe(false);
    expect(credentialsSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
    expect(credentialsSchema.parse({ email: ' A@B.co ', password: 'longenough1' }).email).toBe('a@b.co');
  });
});
