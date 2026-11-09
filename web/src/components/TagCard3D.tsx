import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { memberQR } from '../lib/rules';
import { Avatar } from './Avatar';

interface Props {
  uid: string;
  name: string;
  stateCode: string;
  photoURL: string | null;
  groupName?: string;
  /** "14", "P2", or null when not checked in today */
  tag: string | null;
  status: 'none' | 'waiting' | 'turn' | 'done';
}

/**
 * The member's tag as a 3D card: tilts with the phone (or finger),
 * tap to flip to the big QR the exco scans at the table.
 */
export function TagCard3D({ uid, name, stateCode, photoURL, groupName, tag, status }: Props) {
  const [flipped, setFlipped] = useState(false);
  const flippedRef = useRef(false);
  flippedRef.current = flipped;
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, { stiffness: 150, damping: 18 });
  const sry = useSpring(ry, { stiffness: 150, damping: 18 });
  const glareX = useTransform(sry, [-14, 14], ['10%', '90%']);

  // Gentle tilt from the phone's motion sensor (Android; iPhone needs a permission tap).
  useEffect(() => {
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      if (flippedRef.current) return;
      rx.set(Math.max(-10, Math.min(10, (e.beta - 45) / 4)));
      ry.set(Math.max(-12, Math.min(12, e.gamma / 3)));
    };
    window.addEventListener('deviceorientation', onTilt);
    return () => window.removeEventListener('deviceorientation', onTilt);
  }, [rx, ry]);

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (flipped) return;
    const r = e.currentTarget.getBoundingClientRect();
    ry.set(((e.clientX - r.left) / r.width - 0.5) * 24);
    rx.set(-((e.clientY - r.top) / r.height - 0.5) * 18);
  };
  const reset = () => {
    rx.set(0);
    ry.set(0);
  };

  // Flat while showing the QR so it scans easily.
  useEffect(() => {
    if (flipped) {
      rx.set(0);
      ry.set(0);
    }
  }, [flipped, rx, ry]);

  const statusUi = {
    none: { text: 'Not checked in today', cls: 'bg-white/15 text-white' },
    waiting: { text: 'Waiting for your batch', cls: 'bg-khaki text-green-deep' },
    turn: { text: "It's your turn — go now", cls: 'theme-light bg-white text-green' },
    done: { text: 'Thumbprinted ✓', cls: 'theme-light bg-white text-green' },
  }[status];

  return (
    <div className="mx-auto w-full max-w-[340px] [perspective:1200px]">
      <motion.div
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Show tag number' : 'Show QR code'}
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setFlipped((f) => !f)}
        onPointerMove={onMove}
        onPointerLeave={reset}
        style={{ rotateX: srx, rotateY: sry, transformStyle: 'preserve-3d' }}
        animate={status === 'turn' && !flipped ? { scale: [1, 1.03, 1] } : { scale: 1 }}
        transition={status === 'turn' && !flipped ? { repeat: Infinity, duration: 1.4 } : { duration: 0.3 }}
        className="relative aspect-[5/7] w-full cursor-pointer select-none"
      >
        <motion.div
          className="absolute inset-0"
          style={{ transformStyle: 'preserve-3d' }}
          animate={{ rotateY: flipped ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 120, damping: 16 }}
        >
        {/* FRONT */}
        <div
          className="absolute inset-0 overflow-hidden rounded-[28px] bg-gradient-to-br from-green via-green to-green-dark p-6 text-white shadow-lift [backface-visibility:hidden]"
          style={{ transform: 'translateZ(1px)' }}
        >
          <div className="grid-bg absolute inset-0 opacity-60" />
          <motion.div
            className="pointer-events-none absolute -inset-1/2 rotate-12 bg-gradient-to-r from-transparent via-white/25 to-transparent"
            style={{ left: glareX }}
          />
          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between">
              <span className="text-sm font-extrabold tracking-widest">CDS PASS</span>
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">{groupName ?? 'CDS'}</span>
            </div>

            <div className="mt-5 flex items-center gap-3" style={{ transform: 'translateZ(30px)' }}>
              <Avatar src={photoURL} name={name} size={64} ring />
              <div className="min-w-0">
                <p className="truncate text-lg font-extrabold leading-tight">{name}</p>
                <p className="text-sm font-semibold text-green-mid">{stateCode}</p>
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center" style={{ transform: 'translateZ(60px)' }}>
              <span className="text-xs font-bold tracking-[0.3em] text-green-mid">YOUR NUMBER</span>
              <span
                className="text-[110px] font-extrabold leading-none"
                style={{ textShadow: '0 2px 0 #075a30, 0 4px 0 #064726, 0 6px 0 #053d20, 0 14px 30px rgba(0,0,0,.35)' }}
              >
                {tag ?? '—'}
              </span>
            </div>

            <div className={`rounded-2xl px-4 py-3 text-center text-sm font-extrabold ${statusUi.cls}`}>{statusUi.text}</div>
            <p className="mt-2 text-center text-[11px] font-semibold text-green-mid">Tap to show QR</p>
          </div>
        </div>

        {/* BACK */}
        <div
          className="theme-light absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-[28px] bg-white p-6 shadow-lift [backface-visibility:hidden]"
          style={{ transform: 'rotateY(180deg) translateZ(1px)' }}
        >
          <span className="text-sm font-extrabold tracking-widest text-green">SHOW THIS TO THE EXCO</span>
          <div className="rounded-3xl bg-white p-3 ring-4 ring-green-light">
            <QRCodeSVG value={memberQR(uid)} size={220} level="M" fgColor="#03301A" />
          </div>
          <div className="text-center">
            <p className="text-3xl font-extrabold text-green">{tag ?? '—'}</p>
            <p className="text-sm font-semibold text-muted">
              {name} · {stateCode}
            </p>
          </div>
        </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
