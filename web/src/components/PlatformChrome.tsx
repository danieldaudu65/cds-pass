import { AnimatePresence, motion } from 'framer-motion';
import { useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useAppStatus, usePlatformRole } from '../hooks/usePlatform';
import { Icon } from './ui';

/**
 * Floating mode switch for the CDS Pass admin team: 👤 User · 🧑‍💼 Exco · 🛡️ Admin.
 * Invisible to everyone else.
 */
export function ModeSwitch() {
  const role = usePlatformRole();
  const { profile } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  if (!role || !profile || profile.status !== 'approved') return null;

  const current = pathname.startsWith('/admin') ? 'admin' : pathname.startsWith('/exco') ? 'exco' : 'user';
  const modes = [
    { id: 'user', label: 'User', icon: '👤', to: '/home' },
    ...(profile.role === 'exco' ? [{ id: 'exco', label: 'Exco', icon: '🧑‍💼', to: '/exco' }] : []),
    { id: 'admin', label: 'Admin', icon: '🛡️', to: '/admin' },
  ];
  const now = modes.find((m) => m.id === current) ?? modes[0];

  return (
    <div className="fixed right-3 top-[max(env(safe-area-inset-top),12px)] z-50 lg:right-6">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-full bg-gold px-3 text-xs font-extrabold text-[#3d2e00] shadow-lift"
        aria-label="Switch mode"
      >
        <span>{now.icon}</span> {now.label} <Icon name="chevron" size={14} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            className="absolute right-0 mt-2 w-44 overflow-hidden rounded-2xl border border-line bg-card p-1.5 shadow-lift"
          >
            {modes.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setOpen(false);
                  nav(m.to);
                }}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-bold ${
                  m.id === current ? 'bg-green text-white' : 'text-ink hover:bg-green-light'
                }`}
              >
                <span>{m.icon}</span> {m.label} mode
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Announcement banner set in Admin mode (each person can close it once). */
export function AnnouncementBanner() {
  const status = useAppStatus();
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem('cdspass.bannerClosed') ?? '';
    } catch {
      return '';
    }
  });
  const text = status?.banner;
  if (!text || closed === text) return null;
  return (
    <div className="relative z-40 flex items-start gap-3 bg-gold px-4 py-2.5 text-sm font-semibold text-[#3d2e00]">
      <span>📣</span>
      <p className="flex-1">{text}</p>
      <button
        aria-label="Close announcement"
        onClick={() => {
          setClosed(text);
          try {
            localStorage.setItem('cdspass.bannerClosed', text);
          } catch {
            /* ignore */
          }
        }}
        className="font-extrabold"
      >
        ✕
      </button>
    </div>
  );
}

/** Full-screen notice while maintenance is on (the admin team can still get in). */
export function MaintenanceScreen({ children }: { children: ReactNode }) {
  const status = useAppStatus();
  const role = usePlatformRole();
  if (!status?.maintenance || role) return <>{children}</>;
  return (
    <div className="hero-green grid min-h-[100dvh] place-items-center px-6 text-center text-white">
      <div className="max-w-sm space-y-4">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-3xl bg-white/15 text-4xl">🛠️</div>
        <h1 className="text-2xl font-extrabold">CDS Pass is updating</h1>
        <p className="text-green-mid">{status.maintenance}</p>
        <button onClick={() => location.reload()} className="h-12 rounded-2xl bg-gold px-6 font-bold text-[#3d2e00]">
          Try again
        </button>
      </div>
    </div>
  );
}
