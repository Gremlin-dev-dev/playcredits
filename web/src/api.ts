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
  wallet?: WalletKind;
  balance?: number;
}
export type WalletKind = 'promo' | 'real';
export interface Wallet {
  playCredits: number;
  realMoney: number; // kobo
  realMoneyEnabled: boolean;
  totalWagered: number;
  totalWinnings: number;
  notice: string;
}
export interface LedgerEntry { id: number; type: string; amount: number; balanceAfter: number; balanceType: WalletKind; createdAt: string }
export interface Payment { id: string; kind: 'deposit' | 'withdrawal'; amount: number; status: string; createdAt: string }
export type LimitKind = 'deposit' | 'loss';
export type LimitPeriod = 'daily' | 'weekly' | 'monthly';
export interface Limit { kind: LimitKind; period: LimitPeriod; amount: number | null; pending: { amount: number | null; effectiveAt: string } | null }
export interface Protection {
  limits: Limit[];
  selfExclusion: { active: boolean; permanent: boolean; until: string | null };
}
export interface RealConfig { currency: string; minBetKobo: number; maxBetKobo: number; minDepositKobo: number; maxDepositKobo: number; minWithdrawalKobo: number }
export interface HistoryRow { id: string; bet: number; status: string; payout: number; cashoutMultiplier: number | null; crashPoint: number; startedAt: string; balanceType: WalletKind }
export interface AppConfig { minBet: number; maxBet: number; welcomeBonus: number; notice: string; realMoneyEnabled: boolean; real?: RealConfig }

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
  bet: (amount: number, wallet: WalletKind = 'promo') => call<Round>('POST', '/games/aviator/bet', { amount, wallet }),
  cashout: (id: string) => call<Round>('POST', `/games/aviator/${id}/cashout`),
  round: (id: string) => call<Round>('GET', `/games/aviator/${id}`),
  // Real money (only exists on the server when REAL_MONEY_ENABLED=true)
  deposit: (amount: number) => call<{ reference: string; authorizationUrl: string }>('POST', '/payments/deposits', { amount }),
  withdraw: (amount: number, bankCode: string, accountNumber: string) =>
    call<{ id: string; status: string; amount: number; balance: number }>('POST', '/payments/withdrawals', { amount, bankCode, accountNumber }),
  payments: () => call<Payment[]>('GET', '/payments'),
  protection: () => call<Protection>('GET', '/protection'),
  setLimit: (kind: LimitKind, period: LimitPeriod, amount: number | null) =>
    call<{ applied: boolean } & Protection>('PUT', '/protection/limits', { kind, period, amount }),
  selfExclude: (period: string) => call<{ permanent: boolean; until: string | null }>('POST', '/protection/self-exclusion', { period }),
};
