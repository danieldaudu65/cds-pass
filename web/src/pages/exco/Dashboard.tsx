import { motion } from 'framer-motion';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Icon, Page, Pill, Stat } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { usePendingMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel, tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function Dashboard() {
  const { me, group, session, attendees, stats, open } = useExcoDay();
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  // Dashboard only needs the waiting count, so it reads just those members (not the whole group).
  const pendingCount = usePendingMembers(me.groupId)?.length ?? 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function toggleSession() {
    setError('');
    setBusy(true);
    try {
      if (open) {
        if (!confirm("End today's CDS meeting? Nobody else can check in after this.")) return;
        await api.endSession({});
        toast('Meeting closed', 'info');
      } else {
        await api.startSession({});
        toast("Today's meeting is open", 'success', 'Show the door code so members can scan in.');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const today = new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <ExcoHeader title={group?.name ?? 'CDS group'} sub={`${today} · Group code ${group?.joinCode ?? '…'}`}>
        <div className="grid grid-cols-3 gap-2">
          <Stat value={stats.present} label="Present" />
          <Stat value={stats.done} label="Thumbprinted" />
          <Stat value={stats.waiting} label="Waiting" tone="gold" />
        </div>
      </ExcoHeader>

      <Page className="space-y-4">
        <motion.div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold">Today's meeting</p>
              <p className="text-sm text-muted">{open ? 'Open. Members can scan in.' : session ? 'Closed' : 'Not opened yet'}</p>
            </div>
            <Pill tone={open ? 'green' : 'gold'}>{open ? '● Live' : 'Off'}</Pill>
          </div>
          <Button variant={open ? 'outline' : 'primary'} loading={busy} onClick={toggleSession}>
            {open ? 'End meeting' : "Open today's meeting"}
          </Button>
          <ErrorBox>{error}</ErrorBox>
        </motion.div>

        {open && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { to: '/exco/door', icon: 'door', t: 'Door code', d: 'Members scan in', tone: 'solid' },
              { to: '/exco/call', icon: 'megaphone', t: 'Call batch', d: `Now: ${batchLabel(session?.batch)}`, tone: 'gold' },
              { to: '/exco/table', icon: 'finger', t: 'Table check', d: 'Green or red', tone: 'light' },
              { to: '/exco/members', icon: 'users', t: 'Members', d: pendingCount ? `${pendingCount} to approve` : 'All approved', tone: 'gold' },
            ].map((c, i) => (
              <motion.div key={c.to} initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: i * 0.06 }}>
                <Link
                  to={c.to}
                  className={`block rounded-3xl p-4 shadow-card transition active:scale-[0.98] ${
                    c.tone === 'solid' ? 'number-card text-white' : c.tone === 'gold' ? 'bg-gold-bg text-gold-text' : 'bg-green-light text-green'
                  }`}
                >
                  <span className={`grid h-11 w-11 place-items-center rounded-xl ${c.tone === 'solid' ? 'bg-white/15' : 'bg-card shadow-card'}`}>
                    <Icon name={c.icon as Parameters<typeof Icon>[0]['name']} />
                  </span>
                  <p className="mt-3 font-display font-bold">{c.t}</p>
                  <p className={`text-xs ${c.tone === 'solid' ? 'text-green-mid' : 'opacity-80'}`}>{c.d}</p>
                </Link>
              </motion.div>
            ))}
          </div>
        )}

        {isMainExco && (
          <div className="grid grid-cols-2 gap-3">
            <Link to="/exco/messages" className="flex flex-col gap-2 rounded-3xl bg-gold-bg p-4 text-gold-text shadow-card active:scale-[0.98]">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-card shadow-card">
                <Icon name="bell" />
              </span>
              <span className="font-display font-bold">Send a message</span>
              <span className="text-xs opacity-80">To everyone or a group</span>
            </Link>
            <Link
              to="/exco/give-number"
              className={`flex flex-col gap-2 rounded-3xl bg-green-light p-4 text-green shadow-card active:scale-[0.98] ${open ? '' : 'opacity-60'}`}
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-card shadow-card">
                <Icon name="users" />
              </span>
              <span className="font-display font-bold">Give a number</span>
              <span className="text-xs opacity-80">{open ? 'Phone off? Find them' : 'When the meeting is open'}</span>
            </Link>
          </div>
        )}

        <Link to="/exco/dues" className="card flex items-center gap-3 !p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-gold-bg text-gold-text">
            <Icon name="card" />
          </span>
          <div className="flex-1">
            <p className="font-bold">Dues</p>
            <p className="text-xs text-muted">Bank account, online payments, cash records</p>
          </div>
          <span className="text-green">→</span>
        </Link>

        {!open && pendingCount > 0 && (
          <Link to="/exco/members" className="card flex items-center justify-between !p-4">
            <span className="font-bold">{pendingCount} new members waiting for approval</span>
            <span className="text-green">→</span>
          </Link>
        )}

        {attendees && attendees.length > 0 && (
          <div className="card !p-0">
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <p className="font-bold">Register</p>
              <p className="text-xs text-muted">
                {stats.priority} priority · {stats.manual} manual
              </p>
            </div>
            <ul className="divide-y divide-line">
              {attendees.map((a) => (
                <li key={a.uid} className="flex items-center gap-3 px-5 py-3">
                  <span className={`w-10 text-center font-extrabold ${a.priority ? 'text-warn' : 'text-green'}`}>{tagLabel(a)}</span>
                  <Avatar src={a.photoURL} name={a.fullName} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold">{a.fullName}</p>
                    <p className="text-xs text-muted">
                      {a.stateCode} · {a.checkedInAt?.toDate().toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}
                      {a.method === 'manual' ? ' · manual' : a.method === 'card' ? ' · card' : ''}
                    </p>
                  </div>
                  <Pill tone={a.status === 'done' ? 'green' : 'muted'}>{a.status === 'done' ? 'Done' : 'Waiting'}</Pill>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Page>
    </>
  );
}
