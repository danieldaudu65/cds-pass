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
      <header className="grid-bg relative bg-green-dark px-5 pb-20 pt-[max(1.5rem,env(safe-area-inset-top))] text-white lg:rounded-[28px] lg:px-8 lg:pt-8">
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
          <Avatar src={me.photoURL} name={me.fullName} size={52} ring />
          <div className="min-w-0">
            <p className="text-sm text-green-mid">{greeting()},</p>
            <p className="truncate text-xl font-extrabold">{me.fullName.split(' ')[0]}</p>
            <p className="text-xs font-semibold text-green-mid">
              {me.stateCode} · {group?.name ?? '…'}
            </p>
          </div>
        </div>
      </header>

      <Page className="relative z-10 -mt-14 space-y-4 lg:!px-6">
        <motion.div className="card flex flex-col items-center gap-3 text-center">
          {!open && !att && (
            <>
              <Pill tone="muted">No meeting open</Pill>
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
                className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-green font-bold text-white shadow-[0_8px_0_#064726] active:translate-y-[5px] active:shadow-[0_3px_0_#064726]"
              >
                <Icon name="scan" /> Scan in at the door
              </Link>
              {pending && <p className="text-sm font-semibold text-warn">A saved scan will be sent when you're back online.</p>}
            </>
          )}

          {att && (
            <>
              <Pill tone={session?.status === 'closed' ? 'muted' : status === 'turn' ? 'green' : status === 'done' ? 'green' : 'warn'}>
                {session?.status === 'closed'
                  ? 'Meeting ended'
                  : status === 'turn'
                    ? "It's your turn"
                    : status === 'done'
                      ? 'Thumbprinted ✓'
                      : 'Checked in'}
              </Pill>
              <span className="text-xs font-bold tracking-[0.3em] text-muted">YOUR NUMBER</span>
              <motion.span
                key={tag}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="text-[88px] font-extrabold leading-none text-green"
                style={{ textShadow: '0 3px 0 rgb(var(--line)), 0 6px 0 rgb(var(--green-light))' }}
              >
                {tag}
              </motion.span>
              <div className="grid w-full grid-cols-2 gap-2">
                <div className="rounded-2xl bg-paper p-3 text-left">
                  <p className="text-xs text-muted">Now calling</p>
                  <p className="font-extrabold">{batchLabel(session?.batch)}</p>
                </div>
                <div className="rounded-2xl bg-paper p-3 text-left">
                  <p className="text-xs text-muted">Ahead of you</p>
                  <p className="font-extrabold">{status === 'waiting' ? `${aheadOf(att, session?.batch)} people` : '—'}</p>
                </div>
              </div>
              <Link to="/tag" className="mt-1 text-sm font-bold text-green">
                Open my tag →
              </Link>
            </>
          )}
        </motion.div>

        {status === 'turn' && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex items-center gap-3 rounded-3xl bg-green p-4 text-white shadow-lift"
          >
            <Icon name="finger" size={30} />
            <div>
              <p className="font-extrabold">Go to the thumbprint table now</p>
              <p className="text-sm text-green-mid">Show your tag and your NYSC ID card.</p>
            </div>
          </motion.div>
        )}

        <div className="card space-y-3">
          <p className="font-bold">How it works</p>
          {[
            ['scan', 'Scan the code at the door to get your number.'],
            ['bell', 'Sit down. Your phone buzzes when your batch is called.'],
            ['finger', 'Show your tag at the table, then thumbprint.'],
          ].map(([icon, text]) => (
            <div key={text} className="flex items-center gap-3 text-sm">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-green-light text-green">
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
