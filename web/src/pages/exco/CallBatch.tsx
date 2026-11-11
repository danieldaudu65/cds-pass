import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Page, Pill } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function CallBatch() {
  const { group, session, stats, attendees, open } = useExcoDay();
  const [busy, setBusy] = useState<'' | 'priority' | 'next'>('');
  const [error, setError] = useState('');
  const batch = session?.batch ?? null;
  const size = group?.batchSize ?? 20;
  const nextFrom = (session?.lastTo ?? 0) + 1;
  const lastNumber = Math.max((session?.nextNumber ?? 1) - 1, ...(attendees ?? []).map((a) => a.number), 0);

  const inCurrent =
    batch?.kind === 'regular'
      ? (attendees ?? []).filter((a) => !a.priority && a.number >= batch.from && a.number <= batch.to)
      : batch?.kind === 'priority'
        ? (attendees ?? []).filter((a) => a.priority)
        : [];
  const currentDone = inCurrent.filter((a) => a.status === 'done').length;

  async function call(mode: 'priority' | 'next') {
    setError('');
    setBusy(mode);
    try {
      const r = await api.callNext({ mode });
      toast(`Called ${batchLabel(r.batch)}`, 'success', `${r.notified} phones notified · ${r.inBatch} people in this batch`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <ExcoHeader title="Call batches" sub={`Batch size ${size} · last number given: ${lastNumber}`} />
      <Page className="space-y-4">
        <div className="relative overflow-hidden rounded-[28px] bg-green p-6 text-center text-white shadow-lift">
          <div className="grid-bg absolute inset-0" />
          <p className="relative text-xs font-extrabold tracking-[0.3em] text-green-mid">NOW CALLING</p>
          <AnimatePresence mode="wait">
            <motion.p
              key={batch?.seq ?? 0}
              initial={{ y: 40, opacity: 0, rotateX: -60 }}
              animate={{ y: 0, opacity: 1, rotateX: 0 }}
              exit={{ y: -40, opacity: 0, rotateX: 60 }}
              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
              className="relative text-6xl font-extrabold"
              style={{ textShadow: '0 4px 0 #064726, 0 12px 24px rgba(0,0,0,.3)' }}
            >
              {open ? batchLabel(batch) : session?.status === 'closed' ? 'STOPPED' : '—'}
            </motion.p>
          </AnimatePresence>
          {batch && (
            <p className="relative mt-2 text-sm font-semibold text-green-mid">
              {currentDone} of {inCurrent.length} thumbprinted
            </p>
          )}
        </div>

        {!open && <ErrorBox>Today's meeting is not open.</ErrorBox>}
        {!open && session?.status === 'closed' && (
          <p className="text-center text-sm text-muted">Batch calls and member turn alerts are paused until an exco opens the meeting again.</p>
        )}

        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold">Priority first</p>
            <Pill tone="warn">{stats.priorityWaiting} waiting</Pill>
          </div>
          <p className="text-sm text-muted">Pregnant and nursing mothers with a priority tag can thumbprint any time after this.</p>
          <Button variant="light" className="!bg-warn-bg !text-warn !shadow-none" disabled={!open || stats.priority === 0} loading={busy === 'priority'} onClick={() => call('priority')}>
            Call priority
          </Button>
        </div>

        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-bold">Next batch</p>
            <Pill>
              {nextFrom} – {nextFrom + size - 1}
            </Pill>
          </div>
          <p className="text-sm text-muted">Phones in this batch buzz. Read the numbers out too, for people with no data.</p>
          <Button disabled={!open || nextFrom > lastNumber} loading={busy === 'next'} onClick={() => call('next')}>
            Call next batch
          </Button>
          {open && nextFrom > lastNumber && <p className="text-center text-xs text-muted">Waiting for more people to check in.</p>}
        </div>

        <ErrorBox>{error}</ErrorBox>
        <p className="text-center text-xs text-muted">
          Anyone from an earlier batch who missed their call can still come up. Later numbers are refused at the table.
        </p>
      </Page>
    </>
  );
}
