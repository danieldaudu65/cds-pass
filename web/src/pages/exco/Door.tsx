import { AnimatePresence, motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExcoHeader } from '../../components/ExcoHeader';
import { MemberCard } from '../../components/MemberCard';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Field, Page } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { doorQR, parseQR, tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { Attendee, PublicMember } from '../../lib/types';

type Tab = 'code' | 'scan' | 'manual';

function DoorCode() {
  const [code, setCode] = useState<{ code: string; gid: string; expiresAt: number } | null>(null);
  const [left, setLeft] = useState(30);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const c = await api.getDoorCode({});
      setCode(c);
      setError('');
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!code) return;
      const s = Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s <= 2) void refresh();
    }, 500);
    return () => clearInterval(t);
  }, [code, refresh]);

  // Keep the screen awake while showing the code.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => void lock?.release();
  }, []);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!code) return <div className="card h-[420px] animate-pulse" />;

  return (
    <div className="card flex flex-col items-center gap-4 !p-6">
      <p className="text-sm font-bold text-muted">Members scan this to get their number</p>
      <AnimatePresence mode="wait">
        <motion.div
          key={code.code}
          initial={{ rotateY: -90, opacity: 0 }}
          animate={{ rotateY: 0, opacity: 1 }}
          exit={{ rotateY: 90, opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="theme-light rounded-3xl bg-white p-3 ring-8 ring-green-light"
        >
          <QRCodeSVG value={doorQR(code.gid, code.code)} size={250} level="M" fgColor="#03301A" />
        </motion.div>
      </AnimatePresence>
      <div className="text-center">
        <p className="text-xs font-bold tracking-[0.3em] text-muted">OR TYPE</p>
        <p className="text-5xl font-extrabold tracking-[0.2em] text-green">
          {code.code.slice(0, 3)} {code.code.slice(3)}
        </p>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-line">
        <motion.div className="h-full bg-green" animate={{ width: `${(left / 30) * 100}%` }} transition={{ ease: 'linear', duration: 0.5 }} />
      </div>
      <p className="text-xs text-muted">New code in {left}s. Screenshots stop working after that.</p>
    </div>
  );
}

/** Scan a printed card / tag, or type a state code, for members whose phone can't scan. */
function AssistedCheckIn({ mode }: { mode: 'scan' | 'manual' }) {
  const [found, setFound] = useState<{ member: PublicMember; attendee: Attendee | null; uid: string } | null>(null);
  const [stateCode, setStateCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function lookup(who: { uid?: string; stateCode?: string }) {
    setError('');
    setBusy('lookup');
    try {
      const r = await api.lookupMember(who);
      setFound({ ...r, uid: r.member.uid });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function admit() {
    if (!found) return;
    setBusy('admit');
    try {
      const r = await api.excoCheckIn({ uid: found.uid, method: mode === 'scan' ? 'card' : 'manual' });
      toast(r.already ? `Already No. ${r.number}` : `Checked in · No. ${r.number}`, 'success', found.member.fullName);
      await lookup({ uid: found.uid });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function priority() {
    if (!found) return;
    setBusy('priority');
    try {
      const r = await api.setPriority({ uid: found.uid });
      toast(`Priority tag P${r.pNumber}`, 'success', found.member.fullName);
      setFound({ ...found, attendee: { ...(found.attendee as Attendee), priority: true, pNumber: r.pNumber } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  const reset = () => {
    setFound(null);
    setStateCode('');
    setError('');
  };

  return (
    <div className="space-y-4">
      {!found && mode === 'scan' && (
        <QRScan
          className="aspect-square w-full"
          paused={!!busy}
          onResult={(t) => {
            const q = parseQR(t);
            if (q?.type === 'member') void lookup({ uid: q.uid });
            else setError('That is not a CDS Pass member tag or card.');
          }}
        />
      )}
      {!found && mode === 'manual' && (
        <div className="card space-y-4">
          <Field label="State code" placeholder="LA/26B/1142" autoCapitalize="characters" value={stateCode} onChange={(e) => setStateCode(e.target.value)} />
          <Button loading={busy === 'lookup'} onClick={() => lookup({ stateCode })}>
            Find member
          </Button>
          <p className="text-xs text-muted">Manual check-ins are logged with your name.</p>
        </div>
      )}

      <ErrorBox>{error}</ErrorBox>

      <AnimatePresence>
        {found && (
          <MemberCard
            member={found.member}
            tone={found.member.status !== 'approved' ? 'warn' : found.attendee ? 'ok' : 'neutral'}
            headline={found.attendee ? `No. ${tagLabel(found.attendee)}` : found.member.status !== 'approved' ? 'Not approved yet' : 'Not checked in'}
            detail={found.member.status !== 'approved' ? 'Approve them in Members first.' : undefined}
          >
            {found.member.status === 'approved' && !found.attendee && (
              <Button loading={busy === 'admit'} onClick={admit}>
                Check in (next number)
              </Button>
            )}
            {found.attendee && !found.attendee.priority && (
              <Button variant="light" loading={busy === 'priority'} onClick={priority}>
                Give priority tag (pregnant / nursing mother)
              </Button>
            )}
            {found.member.status !== 'approved' && (
              <Link to="/exco/members" className="block rounded-2xl bg-card py-4 text-center font-bold text-green">
                Go to approvals
              </Link>
            )}
            <Button variant={found.attendee ? 'light' : 'outline'} onClick={reset}>
              Next person
            </Button>
          </MemberCard>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Door() {
  const { open, stats } = useExcoDay();
  const [tab, setTab] = useState<Tab>('code');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'code', label: 'Door code' },
    { id: 'scan', label: 'Scan card' },
    { id: 'manual', label: 'State code' },
  ];

  return (
    <>
      <ExcoHeader title="Door check-in" sub={`${stats.present} checked in so far`}>
        <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/10 p-1">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`relative h-11 rounded-xl text-sm font-bold ${tab === t.id ? 'text-brand' : 'text-white'}`}>
              {tab === t.id && <motion.span layoutId="door-tab" className="absolute inset-0 rounded-xl bg-white" />}
              <span className="relative">{t.label}</span>
            </button>
          ))}
        </div>
      </ExcoHeader>
      <Page>
        {!open ? (
          <div className="card text-center">
            <p className="font-bold">Today's meeting is not open</p>
            <Link to="/exco" className="mt-3 inline-block font-bold text-green">
              Open it from Today →
            </Link>
          </div>
        ) : tab === 'code' ? (
          <DoorCode />
        ) : (
          <AssistedCheckIn key={tab} mode={tab} />
        )}
      </Page>
    </>
  );
}
