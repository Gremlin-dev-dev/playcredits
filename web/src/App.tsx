import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, AppConfig, HistoryRow, LedgerEntry, Round, Wallet, WalletKind } from './api';
import { Cashier, Protect, naira, toKobo } from './Money';

const fmt = (n: number) => n.toLocaleString('en-US');
const multAt = (ms: number) => Math.floor(100 * Math.exp((0.1 * Math.max(0, ms)) / 1000)) / 100; // mirrors server curve (display only)

function Banner({ text, real }: { text: string; real: boolean }) {
  return <div className="banner" role="note">{real ? '18+' : 'SIMULATION'} · {text}</div>;
}

function AuthForm({ cfg, onDone }: { cfg: AppConfig; onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await (mode === 'register' ? api.register(email, password) : api.login(email, password));
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card auth" onSubmit={submit}>
      <h2>{mode === 'register' ? 'Create account' : 'Log in'}</h2>
      {mode === 'register' && (
        <p className="muted">
          {cfg.realMoneyEnabled
            ? `New accounts also get ${fmt(cfg.welcomeBonus)} virtual play credits to practise with. Play credits have no cash value.`
            : `New accounts get ${fmt(cfg.welcomeBonus)} virtual play credits. Credits have no cash value, cannot be withdrawn, and nothing here involves real money.`}
        </p>
      )}
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      <input type="password" placeholder="Password (10+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} maxLength={72} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
      {mode === 'register' && (
        <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> {cfg.realMoneyEnabled ? 'I am 18 or older and understand that gambling involves risk of losing money.' : 'I understand this is a simulation with virtual credits only.'}</label>
      )}
      {err && <p className="error">{err}</p>}
      <button disabled={busy || (mode === 'register' && !agree)}>{mode === 'register' ? 'Register' : 'Log in'}</button>
      <button type="button" className="link" onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
        {mode === 'register' ? 'Have an account? Log in' : 'New here? Register'}
      </button>
    </form>
  );
}

function Aviator({ cfg, onChange }: { cfg: AppConfig; onChange: () => void }) {
  const [kind, setKind] = useState<WalletKind>('promo');
  const [amount, setAmount] = useState(Math.max(cfg.minBet, 500)); // credits, or naira when kind is 'real'
  const [round, setRound] = useState<Round | null>(null);
  const [result, setResult] = useState<Round | null>(null);
  const [mult, setMult] = useState(1);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const clockStart = useRef(0); // performance.now() corresponding to round start

  const open = round?.status === 'open' ? round : null;
  const money = (n: number, w: WalletKind = 'promo') => (w === 'real' ? naira(n) : `${fmt(n)} credits`);
  const real = cfg.real;
  const minBet = kind === 'real' && real ? real.minBetKobo / 100 : cfg.minBet;
  const maxBet = kind === 'real' && real ? real.maxBetKobo / 100 : cfg.maxBet;
  function pick(k: WalletKind) {
    setKind(k);
    setAmount(k === 'real' && real ? real.minBetKobo / 100 : Math.max(cfg.minBet, 500));
  }

  const startClock = (r: Round) => {
    clockStart.current = performance.now() - (r.elapsedMs ?? 0);
    setRound(r);
  };

  // Resume an open round after a page refresh.
  useEffect(() => {
    api.current().then((r) => r && startClock(r)).catch(() => {});
  }, []);

  // Animate the displayed multiplier and poll the server to detect a crash.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const tick = () => {
      setMult(multAt(performance.now() - clockStart.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const poll = setInterval(async () => {
      try {
        const cur = await api.current();
        if (!cur) {
          const settled = await api.round(open.id);
          setResult(settled);
          setRound(null);
          onChange();
        }
      } catch { /* ignore transient errors */ }
    }, 700);
    return () => { cancelAnimationFrame(raf); clearInterval(poll); };
  }, [open?.id]);

  async function place() {
    setErr(''); setResult(null); setBusy(true);
    try {
      const r = await api.bet(kind === 'real' ? toKobo(amount) : amount, kind);
      setMult(1);
      startClock(r);
      onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not place bet');
    } finally { setBusy(false); }
  }
  async function cash() {
    if (!open) return;
    setBusy(true);
    try {
      const r = await api.cashout(open.id);
      setResult(r); setRound(null); onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Cash-out failed');
    } finally { setBusy(false); }
  }

  const crashed = result?.status === 'crashed';
  const shown = open ? mult : result ? (crashed ? result.crashPoint! : result.multiplier!) : 1;
  const t = Math.min(1, Math.log(shown) / Math.log(10));
  return (
    <div className="card">
      <h2>Aviator <span className="tag">{kind === 'real' ? 'real money' : 'virtual credits'}</span></h2>
      {cfg.realMoneyEnabled && !open && (
        <div className="tabs" role="tablist" aria-label="Wallet">
          <button role="tab" aria-selected={kind === 'promo'} className={kind === 'promo' ? 'tab on' : 'tab'} onClick={() => pick('promo')}>Play credits</button>
          <button role="tab" aria-selected={kind === 'real'} className={kind === 'real' ? 'tab on' : 'tab'} onClick={() => pick('real')}>Real money</button>
        </div>
      )}
      <div className={`sky ${crashed ? 'crashed' : ''}`}>
        <svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true">
          <path d={`M0 118 Q ${60 + 120 * t} 118 ${10 + 280 * t} ${118 - 100 * t}`} stroke="currentColor" strokeWidth="3" fill="none" />
        </svg>
        <div className="mult">{shown.toFixed(2)}×</div>
        {crashed && <div className="flew">Flew away!</div>}
        {result?.status === 'cashed_out' && <div className="won">Cashed out +{money(result.payout, result.wallet)}</div>}
      </div>
      {open ? (
        <button className="cash" onClick={cash} disabled={busy}>Cash out {money(Math.floor(open.bet * mult), open.wallet)}</button>
      ) : (
        <div className="row">
          <input type="number" min={minBet} max={maxBet} step={kind === 'real' ? 'any' : 50} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label={kind === 'real' ? 'Bet amount in naira' : 'Bet amount in play credits'} />
          <button onClick={place} disabled={busy}>Place bet</button>
        </div>
      )}
      <p className="muted small">Bet {kind === 'real' ? `${naira(minBet * 100)}–${naira(maxBet * 100)}` : `${fmt(minBet)}–${fmt(maxBet)} credits`}. The crash point is fixed by the server before you bet; its SHA-256 commitment is {open ? <code>{open.seedHash.slice(0, 16)}…</code> : 'shown during a round'}.</p>
      {result?.serverSeed && <p className="muted small">Verify: seed <code>{result.serverSeed.slice(0, 16)}…</code> crash point {result.crashPoint?.toFixed(2)}×.</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function WalletPanel({ wallet, ledger, history, realMoney }: { wallet: Wallet | null; ledger: LedgerEntry[]; history: HistoryRow[]; realMoney: boolean }) {
  return (
    <div className="card">
      <h2>Wallet</h2>
      {realMoney && <div className="balance">{wallet ? naira(wallet.realMoney) : '…'} <span>real money</span></div>}
      <div className={realMoney ? 'balance small-balance' : 'balance'}>{wallet ? fmt(wallet.playCredits) : '…'} <span>play credits</span></div>
      {wallet && <p className="muted small">Play credits: wagered {fmt(wallet.totalWagered)} · won {fmt(wallet.totalWinnings)}</p>}
      <p className="notice">{realMoney ? 'Play credits are virtual and have no cash value. Your real-money balance is shown separately.' : 'Virtual credits only. No cash value, no deposits, and no withdrawals are available.'}</p>
      <h3>Transactions</h3>
      <table><tbody>
        {ledger.map((l) => (
          <tr key={l.id}>
            <td>{l.type.replace(/_/g, ' ')}{l.balanceType === 'real' ? ' (real)' : ''}</td>
            <td className={l.amount < 0 ? 'neg' : 'pos'}>{l.amount > 0 ? '+' : ''}{l.balanceType === 'real' ? naira(l.amount) : fmt(l.amount)}</td>
            <td className="muted">{l.balanceType === 'real' ? naira(l.balanceAfter) : fmt(l.balanceAfter)}</td>
          </tr>
        ))}
      </tbody></table>
      <h3>Recent rounds</h3>
      <table><tbody>
        {history.map((h) => (
          <tr key={h.id}>
            <td>{h.balanceType === 'real' ? naira(h.bet) : fmt(h.bet)}</td>
            <td>{h.status === 'cashed_out' ? `${h.cashoutMultiplier?.toFixed(2)}×` : `crashed ${h.crashPoint.toFixed(2)}×`}</td>
            <td className={h.payout ? 'pos' : 'neg'}>{h.payout ? `+${h.balanceType === 'real' ? naira(h.payout) : fmt(h.payout)}` : '0'}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<{ email: string } | null | undefined>(undefined);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [w, l, h] = await Promise.all([api.wallet(), api.ledger(), api.history()]);
      setWallet(w); setLedger(l); setHistory(h);
    } catch { /* session may have expired */ }
  }, []);

  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
    api.me().then((u) => setUser(u)).catch(() => setUser(null));
  }, []);
  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  // Coming back from Paystack: the balance changes when Paystack confirms, so check a few times.
  const [returned, setReturned] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!user || !(q.has('reference') || q.has('trxref'))) return;
    setReturned(true);
    window.history.replaceState({}, '', window.location.pathname);
    let n = 0;
    const t = setInterval(() => { refresh(); if (++n >= 8) clearInterval(t); }, 3000);
    return () => clearInterval(t);
  }, [user, refresh]);

  if (!cfg || user === undefined) return <p className="center">Loading…</p>;
  return (
    <main>
      <Banner text={cfg.notice} real={cfg.realMoneyEnabled} />
      <header>
        <h1>PlayCredits</h1>
        {user && <button className="link" onClick={async () => { await api.logout(); setUser(null); setWallet(null); }}>Log out ({user.email})</button>}
      </header>
      {!user ? (
        <AuthForm cfg={cfg} onDone={() => api.me().then(setUser)} />
      ) : (
        <div className="grid">
          <Aviator cfg={cfg} onChange={refresh} />
          <WalletPanel wallet={wallet} ledger={ledger} history={history} realMoney={cfg.realMoneyEnabled} />
          {cfg.realMoneyEnabled && returned && <p className="notice full">Thanks! We're confirming your payment with Paystack. Your balance updates as soon as it is confirmed.</p>}
          {cfg.realMoneyEnabled && <Cashier cfg={cfg} wallet={wallet} onChange={refresh} />}
          {cfg.realMoneyEnabled && <Protect />}
        </div>
      )}
    </main>
  );
}
