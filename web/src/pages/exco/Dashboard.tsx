import { motion } from 'framer-motion';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Icon, Page, Pill, Stat } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { batchLabel, tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';

export default function Dashboard() {
  const { me, group, session, attendees, stats, open } = useExcoDay();
  const members = useGroupMembers(me.groupId);
  const pendingCount = members?.filter((m) => m.status === 'pending').length ?? 0;
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
          <Stat value={stats.waiting} label="Waiting" />
        </div>
      </ExcoHeader>

      <Page className="space-y-4">
        <motion.div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold">Today's meeting</p>
              <p className="text-sm text-muted">{open ? 'Open. Members can scan in.' : session ? 'Closed' : 'Not opened yet'}</p>
            </div>
            <Pill tone={open ? 'green' : 'muted'}>{open ? 'Live' : 'Off'}</Pill>
          </div>
          <Button variant={open ? 'outline' : 'primary'} loading={busy} onClick={toggleSession}>
            {open ? 'End meeting' : "Open today's meeting"}
          </Button>
          <ErrorBox>{error}</ErrorBox>
        </motion.div>

        {open && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { to: '/exco/door', icon: 'door', t: 'Door code', d: 'Members scan in' },
              { to: '/exco/call', icon: 'megaphone', t: 'Call batch', d: `Now: ${batchLabel(session?.batch)}` },
              { to: '/exco/table', icon: 'finger', t: 'Table check', d: 'Green or red' },
              { to: '/exco/members', icon: 'users', t: 'Members', d: pendingCount ? `${pendingCount} to approve` : 'All approved' },
            ].map((c) => (
              <Link key={c.to} to={c.to} className="card !p-4 transition active:scale-[0.98]">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-green-light text-green">
                  <Icon name={c.icon} />
                </span>
                <p className="mt-3 font-bold">{c.t}</p>
                <p className="text-xs text-muted">{c.d}</p>
              </Link>
            ))}
          </div>
        )}

        <Link to="/exco/dues" className="card flex items-center gap-3 !p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-green-light text-green">
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
