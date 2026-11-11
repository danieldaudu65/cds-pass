import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Field, Icon, Page, Pill, Stat } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useActiveDues, useDuesStatuses, useGroup, useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { naira } from '../../lib/money';
import { toast } from '../../lib/toast';
import type { Dues } from '../../lib/types';

/** Where the money goes: a bank account checked with Paystack. */
function PayoutAccount() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const [editing, setEditing] = useState(false);
  const [banks, setBanks] = useState<{ name: string; code: string }[] | null>(null);
  const [bankCode, setBankCode] = useState('');
  const [acct, setAcct] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!editing || banks) return;
    api
      .listBanks({})
      .then(setBanks)
      .catch((e) => setError(errorText(e)));
  }, [editing, banks]);

  useEffect(() => {
    setName('');
    if (acct.length !== 10 || !bankCode) return;
    setBusy('resolve');
    setError('');
    api
      .resolveAccount({ bankCode, accountNumber: acct })
      .then((r) => setName(r.accountName))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(''));
  }, [acct, bankCode]);

  async function save() {
    setBusy('save');
    setError('');
    try {
      const bankName = banks?.find((b) => b.code === bankCode)?.name ?? '';
      await api.setPayoutAccount({ bankCode, bankName, accountNumber: acct });
      toast('Dues account saved', 'success', name);
      setEditing(false);
      setAcct('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-green-light text-green">
          <Icon name="bank" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">Dues account</p>
          <p className="truncate text-sm text-muted">
            {group?.payout
              ? `${group.payout.accountName} · ${group.payout.bankName} ****${group.payout.last4}`
              : 'Not set. Members cannot pay online yet.'}
          </p>
        </div>
        {!editing && (
          <button onClick={() => setEditing(true)} className="rounded-xl px-3 py-2 text-sm font-bold text-green">
            {group?.payout ? 'Change' : 'Add'}
          </button>
        )}
      </div>

      <AnimatePresence>
        {editing && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-3 overflow-hidden">
            <div>
              <label htmlFor="bank" className="label">
                Bank
              </label>
              <select id="bank" className="input" value={bankCode} onChange={(e) => setBankCode(e.target.value)}>
                <option value="">{banks ? 'Choose bank' : 'Loading banks…'}</option>
                {banks?.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label="Account number"
              inputMode="numeric"
              maxLength={10}
              placeholder="0123456789"
              value={acct}
              onChange={(e) => setAcct(e.target.value.replace(/\D/g, ''))}
              hint={busy === 'resolve' ? 'Checking account…' : name ? `✓ ${name}` : 'Usually the treasurer’s account. Members will see this name.'}
            />
            <ErrorBox>{error}</ErrorBox>
            <div className="flex gap-2">
              <Button variant="outline" full={false} className="w-28" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button disabled={!name} loading={busy === 'save'} onClick={save}>
                Save account
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NewDues({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    setError('');
    setBusy(true);
    try {
      await api.createDues({ title, amountNaira: Number(amount), dueDate: dueDate || undefined });
      toast('Dues created', 'success', 'Members can pay now.');
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <p className="font-bold">New dues</p>
      <Field label="Title" placeholder="November dues" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Field label="Amount (₦)" inputMode="numeric" placeholder="1000" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      <Field label="Due date (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <ErrorBox>{error}</ErrorBox>
      <div className="flex gap-2">
        <Button variant="outline" full={false} className="w-28" onClick={onDone}>
          Cancel
        </Button>
        <Button loading={busy} disabled={!title || !amount} onClick={create}>
          Create dues
        </Button>
      </div>
    </div>
  );
}

function DuesDetail({ dues }: { dues: Dues }) {
  const me = useMe();
  const members = useGroupMembers(me.groupId);
  const statuses = useDuesStatuses(me.groupId, dues.id);
  const [tab, setTab] = useState<'owing' | 'paid'>('owing');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const rows = useMemo(() => {
    const byUid = new Map((statuses ?? []).map((s) => [s.uid, s]));
    const approved = (members ?? []).filter((m) => m.status === 'approved');
    const q = search.trim().toLowerCase();
    return approved
      .map((m) => ({ m, s: byUid.get(m.uid) }))
      .filter((r) => !q || r.m.fullName.toLowerCase().includes(q) || r.m.stateCode.toLowerCase().includes(q));
  }, [members, statuses, search]);

  const paid = rows.filter((r) => r.s?.status === 'paid');
  const owing = rows.filter((r) => r.s?.status !== 'paid');
  const collected = paid.reduce((t, r) => t + (r.s?.amountKobo ?? 0), 0);
  const cash = paid.filter((r) => r.s?.method === 'cash').reduce((t, r) => t + (r.s?.amountKobo ?? 0), 0);
  const list = tab === 'owing' ? owing : paid;

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    setError('');
    setBusy(label);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <motion.div className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-extrabold">{dues.title}</p>
          <p className="text-sm text-muted">{naira(dues.amountKobo)} per member</p>
        </div>
        <button
          onClick={() => confirm(`Close "${dues.title}"? Members won't be able to pay it any more.`) && run('close', () => api.closeDues({ duesId: dues.id }), 'Dues closed')}
          className="rounded-xl px-3 py-2 text-sm font-bold text-muted"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat tone="light" value={`${paid.length}/${rows.length}`} label="Paid" />
        <Stat tone="light" value={naira(collected)} label="Collected" />
        <Stat tone="light" value={naira(cash)} label="Of it cash" />
      </div>

      <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-line p-1.5">
        {(['owing', 'paid'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`h-11 rounded-xl text-sm font-bold capitalize ${tab === t ? 'bg-card text-green shadow-card' : 'text-muted'}`}>
            {t} ({t === 'owing' ? owing.length : paid.length})
          </button>
        ))}
      </div>

      <input className="input" placeholder="Search name or state code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />

      <ul className="divide-y divide-line">
        {list.map(({ m, s }) => (
          <li key={m.uid} className="flex items-center gap-3 py-3">
            <Avatar src={m.photoURL} name={m.fullName} size={40} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{m.fullName}</p>
              <p className="text-xs text-muted">{m.stateCode}</p>
            </div>
            {s?.status === 'paid' ? (
              <Pill>{s.method === 'cash' ? 'Cash ✓' : 'Online ✓'}</Pill>
            ) : s?.status === 'cash_pending' ? (
              <Pill tone="warn">Awaiting member</Pill>
            ) : (
              <button
                onClick={() =>
                  confirm(`Record ${naira(dues.amountKobo)} cash from ${m.fullName}? They will be asked to confirm it.`) &&
                  run(`cash:${m.uid}`, () => api.recordCash({ uid: m.uid, duesId: dues.id }), 'Cash recorded. Waiting for the member to confirm.')
                }
                disabled={busy === `cash:${m.uid}`}
                className="flex h-10 items-center gap-1.5 rounded-xl bg-green-light px-3 text-sm font-bold text-green disabled:opacity-50"
              >
                <Icon name="cash" size={18} /> Cash
              </button>
            )}
          </li>
        ))}
        {list.length === 0 && <li className="py-4 text-center text-sm text-muted">{tab === 'owing' ? 'Everyone has paid 🎉' : 'No payments yet.'}</li>}
      </ul>

      <ErrorBox>{error}</ErrorBox>
      {owing.length > 0 && (
        <Button
          variant="ghost"
          loading={busy === 'remind'}
          onClick={() => run('remind', () => api.remindDues({ duesId: dues.id }), `Reminder sent to ${owing.length} members`)}
        >
          <Icon name="bell" /> Remind {owing.length} owing
        </Button>
      )}
    </motion.div>
  );
}

export default function DuesAdmin() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const dues = useActiveDues(me.groupId);
  const isMainExco = group?.createdBy === me.uid;
  const [creating, setCreating] = useState(false);

  return (
    <>
      <ExcoHeader title="Dues" sub="Online and cash payments" />
      <Page className="space-y-4">
        <PayoutAccount />
        {isMainExco && (creating ? (
          <NewDues onDone={() => setCreating(false)} />
        ) : (
          <Button onClick={() => setCreating(true)}>+ New dues</Button>
        ))}
        {group && !isMainExco && (
          <p className="rounded-2xl bg-line px-4 py-3 text-sm text-muted">
            Only the main exco who created this CDS group can create new dues. You can still manage existing dues here.
          </p>
        )}
        {dues?.map((d) => <DuesDetail key={d.id} dues={d} />)}
        {dues && dues.length === 0 && !creating && (
          <p className="text-center text-sm text-muted">
            {isMainExco ? 'No open dues. Create one above.' : 'No open dues. Ask the main exco to create one.'}
          </p>
        )}
        <p className="text-center text-xs text-muted">
          Cash only counts after the member confirms it on their phone. Every cash record is in the activity log.
        </p>
      </Page>
    </>
  );
}
