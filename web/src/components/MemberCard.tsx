import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import type { PublicMember } from '../lib/types';
import { Avatar } from './Avatar';

/** Big photo + name + state code: what the exco compares with the NYSC ID card. */
export function MemberCard({
  member,
  tone = 'neutral',
  headline,
  detail,
  children,
}: {
  member: PublicMember;
  tone?: 'ok' | 'bad' | 'warn' | 'neutral';
  headline?: string;
  detail?: string;
  children?: ReactNode;
}) {
  const tones = {
    ok: 'bg-green text-white',
    bad: 'bg-bad text-white',
    warn: 'bg-warn-bg text-warn',
    neutral: 'bg-card text-ink',
  } as const;
  return (
    <motion.div
      initial={{ scale: 0.85, opacity: 0, rotateX: -20 }}
      animate={{ scale: 1, opacity: 1, rotateX: 0 }}
      exit={{ scale: 0.9, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      className={`rounded-[28px] p-5 shadow-lift [perspective:800px] ${tones[tone]}`}
    >
      {headline && <p className="text-center text-2xl font-extrabold">{headline}</p>}
      {detail && <p className="mt-0.5 text-center text-sm font-semibold opacity-90">{detail}</p>}
      <div className="mt-4 flex items-center gap-4 rounded-2xl bg-card p-3 text-ink">
        <Avatar src={member.photoURL} name={member.fullName} size={88} />
        <div className="min-w-0">
          <p className="text-lg font-extrabold leading-tight">{member.fullName}</p>
          <p className="font-semibold text-muted">{member.stateCode}</p>
          <p className="mt-1 text-xs font-bold text-green">Check this against the NYSC ID card</p>
        </div>
      </div>
      {children && <div className="mt-4 space-y-2">{children}</div>}
    </motion.div>
  );
}
