// Minimal structured logger. Never pass passwords, tokens or seeds of open rounds.
type Level = 'info' | 'warn' | 'error';
export function log(level: Level, msg: string, meta: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'test') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  (level === 'error' ? console.error : console.log)(line);
}
