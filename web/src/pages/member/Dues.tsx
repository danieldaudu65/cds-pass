import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ErrorBox, Icon, Page, Pill, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useActiveDues, useDoc, useGroup, useMyPayments } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { duesCharges, naira } from '../../lib/money';
import { toast } from '../../lib/toast';
import type { Dues as DuesItem, DuesStatus } from '../../lib/types';


function DuesCard({ dues, hasAccount }: { dues: DuesItem; hasAccount: boolean }) {
  const me = useMe();
  const status = useDoc<DuesStatus>(`groups/${me.groupId}/dues/${dues.id}/status/${me.uid}`);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const paid = status?.status === 'paid';
  const cashPending = status?.status === 'cash_pending';

  async function pay() {
    setError('');
    setBusy('pay');
    try {
      const r = await api.startPayment({ duesId: dues.id, returnUrl: window.location.origin });
      window.location.href = r.authorizationUrl; // Paystack checkout: card, transfer or USSD
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    }
  }

  async function respond(confirm: boolean) {
    setError('');
    setBusy(confirm ? 'yes' : 'no');
    try {
      await api.respondCash({ duesId: dues.id, confirm });
      toast(confirm ? 'Cash payment confirmed' : 'Reported to your excos', confirm ? 'success' : 'info');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <motion.div className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-extrabold">{dues.title}</p>
          {dues.dueDate && (
            <p className="text-sm text-muted">
              Due {new Date(`${dues.dueDate}T12:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
            </p>
          )}
        </div>
        <p className="text-2xl font-extrabold text-green">{naira(dues.amountKobo)}</p>
      </div>

      {status === undefined ? (
        <div className="h-14 animate-pulse rounded-2xl bg-line" />
      ) : paid ? (
        <div className="flex items-center gap-3 rounded-2xl bg-green-light p-4 text-green">
          <Icon name="check" />
          <div>
            <p className="font-extrabold">Paid</p>
            <p className="text-xs">
              {status.method === 'cash' ? 'Cash, confirmed by you' : 'Online'} ·{' '}
              {status.paidAt?.toDate().toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
            </p>
          </div>
        </div>
      ) : cashPending ? (
        <div className="space-y-3 rounded-2xl bg-warn-bg p-4 text-warn">
          <p className="font-bold">
            {status.recordedByName ?? 'An exco'} recorded {naira(status.amountKobo)} cash from you. Is that correct?
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button loading={busy === 'yes'} onClick={() => respond(true)}>
              Yes, I paid
            </Button>
            <Button variant="outline" loading={busy === 'no'} onClick={() => respond(false)}>
              No, I didn't
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Button loading={busy === 'pay'} disabled={!hasAccount} onClick={pay}>
            <Icon name="card" /> Pay {naira(duesCharges(dues.amountKobo).totalKobo)}
          </Button>
          <p className="text-center text-xs text-muted">
            {naira(dues.amountKobo)} dues + {naira(duesCharges(dues.amountKobo).serviceKobo)} service fee + {naira(duesCharges(dues.amountKobo).paystackKobo)} Paystack charge · card, transfer or USSD
          </p>
          {!hasAccount && <p className="text-center text-xs font-semibold text-warn">Your excos haven't added the CDS bank account yet.</p>}
        </div>
      )}
      <ErrorBox>{error}</ErrorBox>
    </motion.div>
  );
}

export default function Dues() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const dues = useActiveDues(me.groupId);
  const receipts = useMyPayments(me.groupId, me.uid);
  const [params, setParams] = useSearchParams();
  const checked = useRef(false);

  // Coming back from Paystack: confirm the payment straight away.
  useEffect(() => {
    const ref = params.get('reference');
    if (!ref || checked.current) return;
    checked.current = true;
    api
      .verifyPayment({ reference: ref })
      .then((r) =>
        r.status === 'paid'
          ? toast('Payment successful ✓', 'success', 'Your receipt is below.')
          : toast('Payment not completed', 'info', 'If money left your account, it will show here within a few minutes.'),
      )
      .catch((e) => toast('Could not confirm payment yet', 'error', errorText(e)))
      .finally(() => setParams({}, { replace: true }));
  }, [params, setParams]);

  return (
    <>
      <TopBar title="CDS dues" sub={group?.name} />
      <Page className="space-y-4">
        {dues === undefined ? (
          <div className="card h-40 animate-pulse" />
        ) : dues.length === 0 ? (
          <div className="card text-center">
            <p className="font-bold">No dues right now</p>
            <p className="text-sm text-muted">When your excos add dues, they'll show here.</p>
          </div>
        ) : (
          dues.map((d) => <DuesCard key={d.id} dues={d} hasAccount={!!group?.payout} />)
        )}

        {group?.payout && (
          <div className="card flex items-center gap-3 !p-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-green-light text-green">
              <Icon name="bank" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-muted">Dues go straight to</p>
              <p className="truncate font-bold">
                {group.payout.accountName} · {group.payout.bankName} ****{group.payout.last4}
              </p>
            </div>
          </div>
        )}

        <div className="card !p-0">
          <p className="px-5 pb-2 pt-4 font-bold">Receipts</p>
          {!receipts || receipts.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted">No payments yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {receipts.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{r.duesTitle}</p>
                    <p className="text-xs text-muted">
                      {r.method === 'cash' ? 'Cash' : 'Online'} · {r.paidAt?.toDate().toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
                      {r.reference.slice(-8).toUpperCase()}
                    </p>
                  </div>
                  <Pill>{naira(r.amountKobo)}</Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Page>
    </>
  );
}
