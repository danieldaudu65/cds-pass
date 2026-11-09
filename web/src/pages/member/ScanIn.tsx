import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Icon, Page, TopBar } from '../../components/ui';
import { useMyDay } from '../../hooks/useMyDay';
import { api } from '../../lib/api';
import { getPosition } from '../../lib/device';
import { errorText } from '../../lib/firebase';
import { savePending } from '../../lib/offlineQueue';
import { parseQR } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function ScanIn() {
  const nav = useNavigate();
  const { me, att, tag, group } = useMyDay();
  const [typing, setTyping] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send(c: string, gid?: string) {
    if (busy) return;
    setError('');
    if (gid && gid !== me.groupId) return setError('That code is for a different CDS group.');
    setBusy(true);
    const scannedAt = Date.now();
    const pos = group?.venue ? await getPosition() : null;
    const payload = { code: c, gid, ...(pos ?? {}) };

    if (!navigator.onLine) {
      savePending({ ...payload, scannedAt });
      setBusy(false);
      toast('Scan saved', 'info', "No data right now. We'll send it as soon as you're back online.");
      return nav('/home');
    }
    try {
      const r = await api.checkIn(payload);
      navigator.vibrate?.([80, 60, 80]);
      toast(r.already ? `You're already No. ${r.number}` : `You're No. ${r.number}`, 'success', 'Sit down. We will buzz you when your batch is called.');
      nav('/tag');
    } catch (e) {
      const msg = errorText(e);
      if (/internet/i.test(msg)) {
        savePending({ ...payload, scannedAt });
        toast('Scan saved', 'info', "We'll send it when your connection is back.");
        nav('/home');
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  function onScan(text: string) {
    const q = parseQR(text);
    if (q?.type === 'door') void send(q.code, q.gid);
    else setError('That is not a CDS Pass door code. Scan the code on the exco’s screen.');
  }

  if (att) {
    return (
      <>
        <TopBar title="Scan in" back="/home" />
        <Page className="grid place-items-center text-center">
          <div className="card w-full">
            <p className="text-sm text-muted">You're already checked in today</p>
            <p className="text-7xl font-extrabold text-green">{tag}</p>
            <Button className="mt-4" onClick={() => nav('/tag')}>
              Open my tag
            </Button>
          </div>
        </Page>
      </>
    );
  }

  return (
    <>
      <TopBar title="Scan in" back="/home" sub="Point your camera at the code on the exco's screen" />
      <Page className="space-y-4">
        <AnimatePresence mode="wait">
          {!typing ? (
            <motion.div key="cam" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <QRScan onResult={onScan} paused={busy} className="aspect-square w-full shadow-lift" />
            </motion.div>
          ) : (
            <motion.div key="type" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="card space-y-4">
              <p className="font-bold">Type the 6-digit code under the QR</p>
              <input
                autoFocus
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                aria-label="6-digit door code"
                className="input h-20 text-center text-4xl font-extrabold tracking-[0.35em]"
              />
              <Button loading={busy} disabled={code.length !== 6} onClick={() => send(code)}>
                Check in
              </Button>
              <p className="text-center text-xs text-muted">The code changes every 30 seconds. Type the one you see now.</p>
            </motion.div>
          )}
        </AnimatePresence>

        <ErrorBox>{error}</ErrorBox>
        {busy && !typing && <p className="text-center font-semibold text-green">Checking you in…</p>}

        <button
          onClick={() => {
            setTyping((t) => !t);
            setError('');
          }}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-card font-bold text-green shadow-card"
        >
          <Icon name={typing ? 'camera' : 'keypad'} />
          {typing ? 'Use the camera instead' : "Camera not working? Type the code"}
        </button>

        <p className="px-2 text-center text-sm text-muted">
          Phone dead or no camera at all? Go to the exco at the door with your NYSC ID card.
          {group?.venue ? ' Location must be on so we can confirm you are at the venue.' : ''}
        </p>
      </Page>
    </>
  );
}
