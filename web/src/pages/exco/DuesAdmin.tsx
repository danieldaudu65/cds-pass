import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, Checkbox, ErrorBox, Field, Icon, Page, Pill, Select, Stat } from '../../components/ui';
import { dateTime, downloadSheet, slug } from '../../lib/exportSheet';
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
            <Select
              inline
              label="Bank"
              value={bankCode}
              onChange={setBankCode}
              disabled={!banks}
              placeholder={banks ? 'Choose bank' : 'Loading banks…'}
              options={(banks ?? []).map((b) => ({ value: b.code, label: b.name }))}
            />
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
  const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  async function create() {
    setError('');
    if (required && !dueDate) return setError('Choose the collection date first.');
    setBusy(true);
    try {
      await api.createDues({ title, amountNaira: Number(amount), dueDate: dueDate || undefined, requiredForCheckIn: required });
      toast('Dues created', 'success', 'Everyone has been told. Reminders go out the evening before and that morning.');
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
      <Field label={required ? 'Collection date' : 'Collection date (optional)'} type="date" min={today} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <Checkbox checked={required} onChange={setRequired} className="rounded-2xl bg-green-light p-4 text-sm text-green">
        <span className="font-bold">Must pay before getting a number</span>
        <span className="block text-xs opacity-80">
          From the collection date, members who haven't paid see a red “Please pay your dues” screen when they scan, until they pay
          online or you mark their cash as paid.
        </span>
      </Checkbox>
      <p className="text-xs text-muted">Members are told now, then reminded automatically the evening before and that morning.</p>
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
  const [batch, setBatch] = useState('all');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const rows = useMemo(() => {
    const byUid = new Map((statuses ?? []).map((s) => [s.uid, s]));
    const approved = (members ?? []).filter((m) => m.status === 'approved');
    const q = search.trim().toLowerCase().replace(/[\s/-]/g, '');
    return approved
      .map((m) => ({ m, s: byUid.get(m.uid) }))
      .filter((r) => batch === 'all' || r.m.stateCode.split('/')[1] === batch)
      .filter((r) => !q || r.m.fullName.toLowerCase().replace(/\s/g, '').includes(q) || r.m.stateCode.toLowerCase().replace(/[\s/-]/g, '').includes(q));
  }, [members, statuses, search, batch]);

  const batches = useMemo(
    () => [...new Set((members ?? []).filter((m) => m.status === 'approved').map((m) => m.stateCode.split('/')[1]).filter(Boolean))].sort(),
    [members],
  );
  const disputedCount = rows.filter((r) => r.s?.status === 'disputed').length;
  const collection = dues.dueDate
    ? new Date(`${dues.dueDate}T12:00:00`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })
    : null;

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
          <p className="text-sm text-muted">
            {naira(dues.amountKobo)} per member{collection ? ` · collection ${collection}` : ''}
          </p>
          {dues.requiredForCheckIn && <Pill tone="gold">Pay before getting a number</Pill>}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={() => {
              downloadSheet(
                `dues-${slug(dues.title)}`,
                ['Full name', 'State code', 'Status', 'How', 'Amount', 'Recorded by', 'When'],
                rows.map(({ m, s }) => [
                  m.fullName,
                  m.stateCode,
                  s?.status === 'paid' ? 'Paid' : s?.status === 'disputed' ? 'Disputed' : s?.status === 'cash_pending' ? 'Awaiting member' : 'Not paid',
                  s ? (s.method === 'cash' ? 'Cash' : 'Online') : '',
                  s ? naira(s.amountKobo) : '',
                  s?.recordedByName ?? '',
                  dateTime(s?.paidAt ?? s?.recordedAt),
                ]),
              );
              toast('Dues list downloaded', 'success', 'Open it in Excel or Google Sheets.');
            }}
            className="rounded-xl bg-green-light px-3 py-2 text-sm font-bold text-green"
          >
            ⬇ Excel
          </button>
          <button
            onClick={() => confirm(`Close "${dues.title}"? Members won't be able to pay it any more.`) && run('close', () => api.closeDues({ duesId: dues.id }), 'Dues closed')}
            className="rounded-xl px-3 py-2 text-sm font-bold text-muted"
          >
            Close
          </button>
        </div>
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
      {batches.length > 1 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {['all', ...batches].map((b) => (
            <button
              key={b}
              onClick={() => setBatch(b)}
              className={`h-9 shrink-0 rounded-full px-4 text-sm font-bold ${batch === b ? 'bg-green text-white' : 'bg-green-light text-green'}`}
            >
              {b === 'all' ? 'All batches' : `Batch ${b}`}
            </button>
          ))}
        </div>
      )}
      {disputedCount > 0 && (
        <p className="rounded-2xl bg-bad-bg px-4 py-3 text-sm font-semibold text-bad">
          {disputedCount} cash {disputedCount === 1 ? 'record was' : 'records were'} reported as wrong by the member. Check with the exco who recorded it.
        </p>
      )}

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
              <div className="flex items-center gap-2">
                {s?.status === 'disputed' && <Pill tone="bad">Disputed</Pill>}
                <button
                  onClick={() =>
                    confirm(`Mark ${m.fullName} as PAID: ${naira(dues.amountKobo)} cash?\n\nOnly do this after you have received the money. It counts straight away and ${m.fullName.split(' ')[0]} will be told you recorded it.`) &&
                    run(`cash:${m.uid}`, () => api.recordCash({ uid: m.uid, duesId: dues.id }), `${m.fullName.split(' ')[0]} is now paid. They can scan in.`)
                  }
                  disabled={busy === `cash:${m.uid}`}
                  className="flex h-10 items-center gap-1.5 rounded-xl bg-green px-3 text-sm font-bold text-white disabled:opacity-50"
                >
                  <Icon name="cash" size={18} /> Paid (cash)
                </button>
              </div>
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
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
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
          “Paid (cash)” counts immediately. The member is told who recorded it and can tap “This is wrong”. Every cash record is in the activity log.
        </p>
      </Page>
    </>
  );
}
