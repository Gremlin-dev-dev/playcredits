import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, AppConfig, Limit, LimitKind, LimitPeriod, Payment, Protection, Wallet } from './api';

// All server amounts are kobo (NGN x 100). These helpers convert for display and input.
export const naira = (kobo: number) =>
  '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const toKobo = (n: number) => Math.round(n * 100);
const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

type Msg = { ok: boolean; text: string } | null;
function Message({ m }: { m: Msg }) {
  if (!m) return null;
  return <p className={m.ok ? 'okmsg' : 'error'} role="status">{m.text}</p>;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting payment',
  succeeded: 'Completed',
  failed: 'Failed',
  pending_review: 'In review',
  approved: 'Approved',
  paid: 'Paid',
  rejected: 'Rejected',
};

export function Cashier({ cfg, wallet, onChange }: { cfg: AppConfig; wallet: Wallet | null; onChange: () => void }) {
  const real = cfg.real!;
  const [dep, setDep] = useState('1000');
  const [wd, setWd] = useState({ amount: '1000', bankCode: '', accountNumber: '' });
  const [depMsg, setDepMsg] = useState<Msg>(null);
  const [wdMsg, setWdMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [payments, setPayments] = useState<Payment[]>([]);

  const loadPayments = useCallback(() => {
    api.payments().then(setPayments).catch(() => {});
  }, []);
  useEffect(loadPayments, [loadPayments, wallet?.realMoney]);

  async function deposit(e: React.FormEvent) {
    e.preventDefault();
    setDepMsg(null);
    const kobo = toKobo(Number(dep));
    if (!Number.isFinite(kobo) || kobo <= 0) return setDepMsg({ ok: false, text: 'Enter an amount.' });
    setBusy(true);
    try {
      const r = await api.deposit(kobo);
      // Only ever send the player to a secure checkout page.
      if (!r.authorizationUrl.startsWith('https://')) throw new Error('bad url');
      window.location.href = r.authorizationUrl;
    } catch (e) {
      setDepMsg({ ok: false, text: errMsg(e, 'Could not start the deposit. Please try again.') });
      setBusy(false);
    }
  }

  async function withdraw(e: React.FormEvent) {
    e.preventDefault();
    setWdMsg(null);
    const kobo = toKobo(Number(wd.amount));
    if (!Number.isFinite(kobo) || kobo <= 0) return setWdMsg({ ok: false, text: 'Enter an amount.' });
    setBusy(true);
    try {
      await api.withdraw(kobo, wd.bankCode.trim(), wd.accountNumber.trim());
      setWdMsg({ ok: true, text: 'Withdrawal requested. We review every request before paying out.' });
      onChange();
      loadPayments();
    } catch (e) {
      setWdMsg({ ok: false, text: errMsg(e, 'Could not request the withdrawal.') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Cashier <span className="tag">real money · NGN</span></h2>
      <div className="balance">{wallet ? naira(wallet.realMoney) : '…'} <span>balance</span></div>

      <h3>Deposit</h3>
      <form className="stack" onSubmit={deposit}>
        <label className="field">Amount (₦)
          <input type="number" inputMode="decimal" min={real.minDepositKobo / 100} max={real.maxDepositKobo / 100} step="any" value={dep} onChange={(e) => setDep(e.target.value)} required />
        </label>
        <p className="muted small">{naira(real.minDepositKobo)} – {naira(real.maxDepositKobo)} per deposit. You will pay on Paystack's secure page.</p>
        <button disabled={busy}>Deposit with Paystack</button>
        <Message m={depMsg} />
      </form>

      <h3>Withdraw</h3>
      <form className="stack" onSubmit={withdraw}>
        <label className="field">Amount (₦)
          <input type="number" inputMode="decimal" min={real.minWithdrawalKobo / 100} step="any" value={wd.amount} onChange={(e) => setWd({ ...wd, amount: e.target.value })} required />
        </label>
        <label className="field">Bank code
          <input type="text" inputMode="numeric" pattern="\d{3,6}" placeholder="e.g. 058" value={wd.bankCode} onChange={(e) => setWd({ ...wd, bankCode: e.target.value })} required />
        </label>
        <label className="field">Account number
          <input type="text" inputMode="numeric" pattern="\d{10}" maxLength={10} placeholder="10 digits" value={wd.accountNumber} onChange={(e) => setWd({ ...wd, accountNumber: e.target.value })} required />
        </label>
        <p className="muted small">Minimum {naira(real.minWithdrawalKobo)}. Your identity must be verified before you can withdraw.</p>
        <button disabled={busy}>Request withdrawal</button>
        <Message m={wdMsg} />
      </form>

      <h3>Payments</h3>
      {payments.length === 0 ? (
        <p className="muted small">No payments yet.</p>
      ) : (
        <table><tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td>{p.kind}</td>
              <td className={p.kind === 'deposit' ? 'pos' : 'neg'}>{p.kind === 'deposit' ? '+' : '−'}{naira(p.amount)}</td>
              <td className="muted">{STATUS_LABEL[p.status] ?? p.status}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

const PERIODS: LimitPeriod[] = ['daily', 'weekly', 'monthly'];

function LimitRow({ kind, period, limit, onSaved }: { kind: LimitKind; period: LimitPeriod; limit?: Limit; onSaved: (p: Protection, applied: boolean) => void }) {
  const [val, setVal] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function save(amount: number | null) {
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.setLimit(kind, period, amount);
      onSaved(r, r.applied);
      setVal('');
      setMsg(r.applied ? { ok: true, text: 'Saved.' } : { ok: true, text: 'Change scheduled: increases and removals take effect after 24 hours.' });
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e, 'Could not save the limit.') });
    } finally {
      setBusy(false);
    }
  }
  const n = Number(val);
  return (
    <div className="limit">
      <div className="limit-head">
        <strong>{period}</strong>
        <span className="muted small">
          {limit?.amount != null ? naira(limit.amount) : 'No limit'}
          {limit?.pending && ` · ${limit.pending.amount === null ? 'removal' : `changing to ${naira(limit.pending.amount)}`} on ${new Date(limit.pending.effectiveAt).toLocaleString()}`}
        </span>
      </div>
      <div className="row">
        <input type="number" inputMode="decimal" min="1" step="any" placeholder="New limit (₦)" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`${period} ${kind} limit in naira`} />
        <button disabled={busy || !(n > 0)} onClick={() => save(toKobo(n))}>Set</button>
        <button className="secondary" disabled={busy || limit?.amount == null} onClick={() => save(null)}>Remove</button>
      </div>
      <Message m={msg} />
    </div>
  );
}

const EXCLUSION_OPTIONS: [string, string][] = [
  ['24h', '24 hours (cool-off)'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['180d', '6 months'],
  ['permanent', 'Permanently'],
];

export function Protect() {
  const [p, setP] = useState<Protection | null>(null);
  const [period, setPeriod] = useState('24h');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.protection().then(setP).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function exclude() {
    const label = EXCLUSION_OPTIONS.find(([v]) => v === period)?.[1] ?? period;
    const sure = window.confirm(
      `Exclude yourself for: ${label}?\n\nYou will not be able to deposit or bet real money until it ends. You cannot shorten it later${period === 'permanent' ? ', and a permanent exclusion cannot be undone' : ''}.`,
    );
    if (!sure) return;
    setMsg(null);
    setBusy(true);
    try {
      await api.selfExclude(period);
      load();
      setMsg({ ok: true, text: 'Self-exclusion is now active.' });
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e, 'Could not set self-exclusion.') });
    } finally {
      setBusy(false);
    }
  }

  const find = (kind: LimitKind, period: LimitPeriod) => p?.limits.find((l) => l.kind === kind && l.period === period);
  const ex = p?.selfExclusion;
  return (
    <div className="card">
      <h2>Play responsibly</h2>
      <p className="muted small">Set limits that protect you. Lowering a limit is instant; raising or removing one takes 24 hours.</p>
      {(['deposit', 'loss'] as LimitKind[]).map((kind) => (
        <section key={kind}>
          <h3>{kind === 'deposit' ? 'Deposit limits' : 'Loss limits'}</h3>
          {PERIODS.map((period) => (
            <LimitRow key={period} kind={kind} period={period} limit={find(kind, period)} onSaved={(np) => setP(np)} />
          ))}
        </section>
      ))}

      <h3>Self-exclusion</h3>
      {ex?.active ? (
        <p className="notice">You are excluded from real-money play {ex.permanent ? 'permanently' : `until ${new Date(ex.until!).toLocaleString()}`}. You can still withdraw your balance.</p>
      ) : (
        <p className="muted small">Take a break from real-money play. It starts immediately and cannot be shortened.</p>
      )}
      <div className="row">
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Exclusion period">
          {EXCLUSION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="danger" disabled={busy} onClick={exclude}>{ex?.active ? 'Extend exclusion' : 'Exclude me'}</button>
      </div>
      <Message m={msg} />
      <p className="muted small">If gambling is causing you or someone close to you harm, please stop and talk to someone you trust or a health professional.</p>
    </div>
  );
}
