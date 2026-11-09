import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { ExcoHeader } from '../../components/ExcoHeader';
import { MemberCard } from '../../components/MemberCard';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Field, Icon, Page } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel, parseQR } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { TableCheckResponse } from '../../lib/types';

function verdict(r: TableCheckResponse) {
  const tag = r.priority && r.pNumber ? `P${r.pNumber}` : `No. ${r.number}`;
  switch (r.result) {
    case 'your_turn':
      return { tone: 'ok' as const, headline: `${tag} · Your turn ✓`, detail: 'Check the ID card, then the LGI thumbprints.' };
    case 'not_turn':
      return { tone: 'bad' as const, headline: `${tag} · Not your turn`, detail: `Now calling ${batchLabel(r.batch)}. Please wait.` };
    case 'already_done':
      return {
        tone: 'bad' as const,
        headline: 'Already thumbprinted',
        detail: r.doneAt ? `Done at ${new Date(r.doneAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}. This tag is used up.` : 'This tag is used up.',
      };
    case 'not_checked_in':
      return { tone: 'bad' as const, headline: 'Not checked in today', detail: 'They must check in at the door first.' };
    case 'not_started':
      return { tone: 'warn' as const, headline: `${tag} · Not started`, detail: 'Call priority or the first batch first.' };
  }
}

export default function Table() {
  const { session, stats, open } = useExcoDay();
  const [result, setResult] = useState<TableCheckResponse | null>(null);
  const [manual, setManual] = useState(false);
  const [stateCode, setStateCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function check(who: { uid?: string; stateCode?: string }) {
    setError('');
    setBusy('check');
    try {
      const r = await api.tableCheck(who);
      navigator.vibrate?.(r.result === 'your_turn' ? 80 : [200, 80, 200]);
      setResult(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function done() {
    if (!result) return;
    setBusy('done');
    try {
      await api.markDone({ uid: result.member.uid });
      toast('Thumbprinted ✓', 'success', result.member.fullName);
      setResult(null);
      setStateCode('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  const v = result ? verdict(result) : null;

  return (
    <>
      <ExcoHeader title="Thumbprint table" sub={`Now calling ${batchLabel(session?.batch)} · ${stats.done} done`} />
      <Page className="space-y-4">
        {!open && <ErrorBox>Today's meeting is not open.</ErrorBox>}

        <AnimatePresence mode="wait">
          {result && v ? (
            <motion.div key="result" className="space-y-3">
              <MemberCard member={result.member} tone={v.tone} headline={v.headline} detail={v.detail}>
                {result.result === 'your_turn' ? (
                  <>
                    <Button variant="light" loading={busy === 'done'} onClick={done}>
                      <Icon name="check" /> Thumbprinted: Done
                    </Button>
                    <Button variant="ghost" className="!bg-white/15 !text-white" onClick={() => setResult(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button variant="light" onClick={() => setResult(null)}>
                    Next person
                  </Button>
                )}
              </MemberCard>
            </motion.div>
          ) : manual ? (
            <motion.div key="manual" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="card space-y-4">
              <Field label="State code (phone dead / no tag)" placeholder="LA/26B/1142" autoCapitalize="characters" value={stateCode} onChange={(e) => setStateCode(e.target.value)} />
              <Button loading={busy === 'check'} onClick={() => check({ stateCode })}>
                Check turn
              </Button>
            </motion.div>
          ) : (
            <motion.div key="scan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <QRScan
                className="aspect-square w-full shadow-lift"
                paused={!!busy || !!result}
                onResult={(t) => {
                  const q = parseQR(t);
                  if (q?.type === 'member') void check({ uid: q.uid });
                  else setError('Scan the member’s CDS Pass tag or printed card.');
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <ErrorBox>{error}</ErrorBox>

        {!result && (
          <button
            onClick={() => {
              setManual((m) => !m);
              setError('');
            }}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-card font-bold text-green shadow-card"
          >
            <Icon name={manual ? 'camera' : 'keypad'} />
            {manual ? 'Scan a tag instead' : 'No tag? Use state code'}
          </button>
        )}
      </Page>
    </>
  );
}
