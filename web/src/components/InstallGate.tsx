import { motion } from 'framer-motion';
import { useMemo, useState, type ReactNode } from 'react';
import { mustInstall, platform, promptInstall, useInstallState } from '../lib/install';
import { Button } from './ui';

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-green text-sm font-extrabold text-white">{n}</span>
      <span className="pt-1 text-sm">{children}</span>
    </li>
  );
}

const ShareIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="inline -mt-1" aria-label="Share">
    <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);

/** On phones, CDS Pass only runs as an installed app (home-screen icon). */
export function InstallGate({ children }: { children: ReactNode }) {
  const needed = useMemo(mustInstall, []);
  const { canPrompt, justInstalled, standalone } = useInstallState();
  const [busy, setBusy] = useState(false);
  const p = useMemo(platform, []);

  if (!needed || standalone) return <>{children}</>;

  return (
    <div className="screen bg-green-dark text-white">
      <div className="grid-bg flex flex-1 flex-col px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
        <motion.div
          initial={{ y: 20, opacity: 0, rotate: -6 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 160, damping: 14 }}
          className="mx-auto"
        >
          <motion.img
            src="/icon-512.png"
            alt="CDS Pass"
            animate={{ y: [0, -8, 0] }}
            transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
            className="h-28 w-28 rounded-[30px] shadow-lift"
          />
        </motion.div>

        <h1 className="mt-6 text-center text-3xl font-extrabold leading-tight">Install CDS Pass</h1>
        <p className="mt-2 text-center text-green-mid">
          CDS Pass works as an app on your phone, so it can buzz you when your batch is called, even with the screen off.
        </p>

        <div className="mt-8 rounded-3xl bg-card p-5 text-ink shadow-lift">
          {justInstalled ? (
            <div className="space-y-2 text-center">
              <p className="text-lg font-extrabold text-green">Installed ✓</p>
              <p className="text-sm text-muted">Close this browser and open CDS Pass from your home screen.</p>
            </div>
          ) : p === 'inapp' ? (
            <ol className="space-y-4">
              <Step n={1}>You opened this link inside another app (like WhatsApp).</Step>
              <Step n={2}>
                Tap the <b>⋮</b> or <b>…</b> menu and choose <b>Open in Chrome</b> (or <b>Open in Safari</b> on iPhone).
              </Step>
              <Step n={3}>Then install CDS Pass from there.</Step>
            </ol>
          ) : p === 'ios' ? (
            <ol className="space-y-4">
              <Step n={1}>
                Open this page in <b>Safari</b>.
              </Step>
              <Step n={2}>
                Tap the <b>Share</b> button <ShareIcon /> at the bottom of the screen.
              </Step>
              <Step n={3}>
                Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.
              </Step>
              <Step n={4}>Open CDS Pass from your home screen.</Step>
            </ol>
          ) : canPrompt ? (
            <div className="space-y-3">
              <Button
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await promptInstall();
                  setBusy(false);
                }}
              >
                Install app
              </Button>
              <p className="text-center text-xs text-muted">Free · about 1 MB · no Play Store needed</p>
            </div>
          ) : (
            <ol className="space-y-4">
              <Step n={1}>
                Tap the <b>⋮</b> menu at the top right of Chrome.
              </Step>
              <Step n={2}>
                Tap <b>Install app</b> or <b>Add to Home screen</b>.
              </Step>
              <Step n={3}>Open CDS Pass from your home screen.</Step>
            </ol>
          )}
        </div>

        <p className="mt-auto pt-8 text-center text-xs text-green-mid">
          On a laptop? CDS Pass works straight in the browser, no install needed.
        </p>
      </div>
    </div>
  );
}
