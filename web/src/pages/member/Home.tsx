import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Icon, Page, Pill } from '../../components/ui';
import { useMyDay } from '../../hooks/useMyDay';
import { aheadOf, batchLabel } from '../../lib/rules';
import { getPending } from '../../lib/offlineQueue';

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const { me, group, session, att, status, tag } = useMyDay();
  const pending = getPending();
  const open = session?.status === 'open';

  return (
    <>
      <header className="hero-green relative px-5 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))] text-white lg:rounded-[28px] lg:px-8 lg:pt-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="h-9 w-9 rounded-xl" />
            <span className="font-extrabold">CDS Pass</span>
          </div>
          {me.role === 'exco' && (
            <Link to="/exco" className="rounded-full bg-white/15 px-3 py-2 text-xs font-bold">
              Exco mode →
            </Link>
          )}
        </div>
        <div className="mt-6 flex items-center gap-3">
          <Avatar src={me.photoURL} name={me.fullName} size={56} ring />
          <div className="min-w-0">
            <p className="text-sm text-green-mid">{greeting()},</p>
            <h1 className="truncate text-2xl font-extrabold leading-tight">{me.fullName.split(' ')[0]}</h1>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">{me.stateCode}</span>
              <span className="max-w-[160px] truncate rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">{group?.name ?? '…'}</span>
            </div>
          </div>
        </div>
      </header>

      <Page className="relative z-10 -mt-14 space-y-4 lg:!px-6">
        {!att && <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className={`card flex flex-col items-center gap-3 text-center ${open ? '' : 'border-2 border-gold/60'}`}>
          <span className={`grid h-14 w-14 place-items-center rounded-2xl ${open ? 'bg-green text-white' : 'bg-gold-bg text-gold-text'}`}>
            <Icon name={open ? 'scan' : 'bell'} size={26} />
          </span>
          {!open && !att && (
            <>
              <Pill tone="gold">No meeting open</Pill>
              <p className="text-lg font-extrabold">Today's CDS hasn't started</p>
              <p className="text-sm text-muted">When an exco opens the meeting, scan the code at the door to get your number.</p>
            </>
          )}

          {open && !att && (
            <>
              <Pill>Meeting is open</Pill>
              <p className="text-lg font-extrabold">You're not checked in yet</p>
              <Link
                to="/scan"
                className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gold font-bold text-[#3d2e00] shadow-[0_8px_0_#B39B5A] active:translate-y-[5px] active:shadow-[0_3px_0_#B39B5A]"
              >
                <Icon name="scan" /> Scan in at the door
              </Link>
              {pending && <p className="text-sm font-semibold text-warn">A saved scan will be sent when you're back online.</p>}
            </>
          )}

        </motion.div>}

        {!att && (
          <div className="grid grid-cols-2 gap-3">
            <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.08 }} className="rounded-3xl bg-green-light p-4">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-green shadow-card">
                <Icon name="door" size={18} />
              </span>
              <p className="mt-3 text-xs font-semibold text-green">Today's meeting</p>
              <p className="font-display text-xl font-extrabold text-green">{open ? 'Open now' : session?.status === 'closed' ? 'Ended' : 'Not open'}</p>
            </motion.div>
            <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.16 }}>
              <Link to="/dues" className="block h-full rounded-3xl bg-gold-bg p-4">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-gold-text shadow-card">
                  <Icon name="card" size={18} />
                </span>
                <p className="mt-3 text-xs font-semibold text-gold-text">Dues</p>
                <p className="font-display text-xl font-extrabold text-gold-text">Check & pay →</p>
              </Link>
            </motion.div>
          </div>
        )}

        {att && (
          <>
            <motion.div
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className={`number-card relative overflow-hidden rounded-[30px] p-6 text-white ${status === 'turn' && session?.status !== 'closed' ? 'turn-glow' : ''}`}
            >
              <span className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full border-[28px] border-white/[0.07]" />
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                  session?.status === 'closed' ? 'bg-white/15 text-white' : status === 'turn' ? 'bg-gold text-[#3d2e00]' : 'bg-white/15 text-white'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${status === 'turn' && session?.status !== 'closed' ? 'bg-[#3d2e00]' : 'bg-white'}`} />
                {session?.status === 'closed'
                  ? 'Meeting ended'
                  : status === 'turn'
                    ? "It's your turn!"
                    : status === 'done'
                      ? 'Thumbprinted ✓'
                      : 'Checked in'}
              </span>
              <p className="mt-4 text-xs font-bold tracking-[0.25em] text-green-mid">YOUR NUMBER</p>
              <motion.p
                key={tag}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 220, damping: 16 }}
                className="font-display text-[92px] font-extrabold leading-[0.95]"
                style={{ textShadow: '0 5px 0 rgba(0,0,0,.14)' }}
              >
                {tag}
              </motion.p>
            </motion.div>

            <div className="grid grid-cols-2 gap-3">
              <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.08 }} className="rounded-3xl bg-green-light p-4">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-green shadow-card">
                  <Icon name="megaphone" size={18} />
                </span>
                <p className="mt-3 text-xs font-semibold text-green">Now calling</p>
                <motion.p key={batchLabel(session?.batch)} initial={{ rotateX: 90 }} animate={{ rotateX: 0 }} className="font-display text-2xl font-extrabold text-green">
                  {batchLabel(session?.batch)}
                </motion.p>
              </motion.div>
              <motion.div initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.16 }} className="rounded-3xl bg-gold-bg p-4">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-card text-gold-text shadow-card">
                  <Icon name="users" size={18} />
                </span>
                <p className="mt-3 text-xs font-semibold text-gold-text">Ahead of you</p>
                <p className="font-display text-2xl font-extrabold text-gold-text">
                  {status === 'waiting' ? `${aheadOf(att, session?.batch)} people` : '—'}
                </p>
              </motion.div>
            </div>

            <Link to="/tag" className="card flex items-center justify-between !py-4">
              <span className="font-display font-bold">Open my tag</span>
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-green text-white">→</span>
            </Link>
          </>
        )}

        {status === 'turn' && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex items-center gap-3 rounded-3xl border-2 border-gold bg-gold-bg p-4 text-gold-text"
          >
            <Icon name="finger" size={30} />
            <div>
              <p className="font-extrabold">Go to the thumbprint table now</p>
              <p className="text-sm opacity-80">Show your tag and your NYSC ID card.</p>
            </div>
          </motion.div>
        )}

        <div className="card space-y-3">
          <h3 className="font-bold">How it works</h3>
          {[
            ['scan', 'Scan the code at the door to get your number.'],
            ['bell', 'Sit down. Your phone buzzes when your batch is called.'],
            ['finger', 'Show your tag at the table, then thumbprint.'],
          ].map(([icon, text], i) => (
            <div key={text} className="flex items-center gap-3 text-sm">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${i === 2 ? 'bg-gold-bg text-gold-text' : 'bg-green-light text-green'}`}>
                <Icon name={icon} size={20} />
              </span>
              {text}
            </div>
          ))}
        </div>
      </Page>
    </>
  );
}
