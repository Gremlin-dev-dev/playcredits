export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Request failed');
  return data as T;
}

export interface Round {
  id: string;
  status: 'open' | 'cashed_out' | 'crashed';
  bet: number;
  seedHash: string;
  elapsedMs?: number;
  multiplier?: number;
  crashPoint?: number;
  serverSeed?: string;
  payout: number;
  balance?: number;
}
export interface Wallet { playCredits: number; totalWagered: number; totalWinnings: number; notice: string }
export interface LedgerEntry { id: number; type: string; amount: number; balanceAfter: number; createdAt: string }
export interface HistoryRow { id: string; bet: number; status: string; payout: number; cashoutMultiplier: number | null; crashPoint: number; startedAt: string }
export interface AppConfig { minBet: number; maxBet: number; welcomeBonus: number; notice: string }

export const api = {
  config: () => call<AppConfig>('GET', '/config'),
  me: () => call<{ id: string; email: string }>('GET', '/me'),
  register: (email: string, password: string) => call<{ email: string }>('POST', '/auth/register', { email, password }),
  login: (email: string, password: string) => call<{ email: string }>('POST', '/auth/login', { email, password }),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  wallet: () => call<Wallet>('GET', '/wallet'),
  ledger: () => call<LedgerEntry[]>('GET', '/wallet/ledger?limit=30'),
  history: () => call<HistoryRow[]>('GET', '/games/history'),
  current: () => call<Round | null>('GET', '/games/aviator/current'),
  bet: (amount: number) => call<Round>('POST', '/games/aviator/bet', { amount }),
  cashout: (id: string) => call<Round>('POST', `/games/aviator/${id}/cashout`),
  round: (id: string) => call<Round>('GET', `/games/aviator/${id}`),
};
