import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { MemberCard } from '../../components/MemberCard';
import { QRScan } from '../../components/QRScan';
import { Button, ErrorBox, Icon, Page, Pill } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { parseQR } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { Profile } from '../../lib/types';

type Filter = 'pending' | 'approved' | 'excos';

export default function Members() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const members = useGroupMembers(me.groupId);
  const isMainExco = group?.createdBy === me.uid;
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Profile | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const counts = useMemo(
    () => ({
      pending: members?.filter((m) => m.status === 'pending').length ?? 0,
      approved: members?.filter((m) => m.status === 'approved').length ?? 0,
      excos: members?.filter((m) => m.role === 'exco').length ?? 0,
    }),
    [members],
  );

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (members ?? [])
      .filter((m) => (filter === 'pending' ? m.status === 'pending' : filter === 'excos' ? m.role === 'exco' : m.status === 'approved'))
      .filter((m) => !q || m.fullName.toLowerCase().includes(q) || m.stateCode.toLowerCase().includes(q));
  }, [members, filter, search]);

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    setError('');
    setBusy(label);
    try {
      await fn();
      toast(done, 'success', selected?.fullName);
      setSelected(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  function resetPin() {
    if (!selected) return;
    const pin = prompt(`New 6-digit PIN for ${selected.fullName}:\n(Only after checking their NYSC ID card)`);
    if (pin == null) return;
    if (!/^\d{6}$/.test(pin)) return setError('The PIN must be 6 digits.');
    void run('pin', () => api.resetPin({ uid: selected.uid, pin }), 'PIN reset. Tell them their new PIN privately.');
  }

  return (
    <>
      <ExcoHeader title="Members" sub={`${counts.approved} approved · ${counts.pending} waiting`}>
        <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white/10 p-1">
          {(['pending', 'approved', 'excos'] as Filter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`relative h-11 rounded-xl text-sm font-bold capitalize ${filter === f ? 'text-brand' : 'text-white'}`}>
              {filter === f && <motion.span layoutId="mem-tab" className="absolute inset-0 rounded-xl bg-white" />}
              <span className="relative">
                {f === 'pending' ? 'To approve' : f} ({counts[f]})
              </span>
            </button>
          ))}
        </div>
      </ExcoHeader>

      <Page className="space-y-4">
        <AnimatePresence mode="wait">
          {selected ? (
            <motion.div key="sel">
              <MemberCard
                member={selected}
                tone={selected.status === 'pending' ? 'warn' : 'neutral'}
                headline={selected.status === 'pending' ? 'Check their NYSC ID card' : selected.role === 'exco' ? 'Exco' : 'Member'}
                detail={selected.status === 'pending' ? 'Name, state code and face must match the card.' : selected.phone}
              >
                {selected.status === 'pending' && (
                  <>
                    <Button loading={busy === 'approve'} onClick={() => run('approve', () => api.approveMember({ uid: selected.uid, approve: true }), 'Approved')}>
                      <Icon name="check" /> Approve
                    </Button>
                    <Button variant="danger" loading={busy === 'reject'} onClick={() => run('reject', () => api.approveMember({ uid: selected.uid, approve: false }), 'Rejected')}>
                      <Icon name="x" /> Reject
                    </Button>
                  </>
                )}
                {selected.status === 'approved' && selected.uid !== me.uid && isMainExco && (
                  <Button
                    variant="outline"
                    loading={busy === 'role'}
                    onClick={() =>
                      run(
                        'role',
                        () => api.setRole({ uid: selected.uid, role: selected.role === 'exco' ? 'member' : 'exco' }),
                        selected.role === 'exco' ? 'Removed as exco' : 'Made exco',
                      )
                    }
                  >
                    {selected.role === 'exco' ? 'Remove as exco' : 'Make exco'}
                  </Button>
                )}
                {selected.status === 'approved' && selected.uid !== me.uid && group && !isMainExco && (
                  <p className="rounded-xl bg-line px-3 py-2 text-sm text-muted">
                    Only the main exco who created this CDS group can change exco roles.
                  </p>
                )}
                {selected.status === 'approved' && (
                  <Button variant="ghost" loading={busy === 'pin'} onClick={resetPin}>
                    Reset PIN
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setSelected(null)}>
                  Back to list
                </Button>
              </MemberCard>
            </motion.div>
          ) : scanning ? (
            <motion.div key="scan" className="space-y-3">
              <QRScan
                className="aspect-square w-full"
                onResult={(t) => {
                  const q = parseQR(t);
                  const m = q?.type === 'member' ? members?.find((x) => x.uid === q.uid) : undefined;
                  if (m) {
                    setSelected(m);
                    setScanning(false);
                  } else setError('That code is not a member of your CDS group.');
                }}
              />
              <Button variant="outline" onClick={() => setScanning(false)}>
                Close camera
              </Button>
            </motion.div>
          ) : (
            <motion.div key="list" className="space-y-3">
              <div className="flex gap-2">
                <input className="input flex-1" placeholder="Search name or state code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />
                <button onClick={() => setScanning(true)} aria-label="Scan member code" className="grid h-14 w-14 place-items-center rounded-2xl bg-green text-white">
                  <Icon name="scan" />
                </button>
              </div>

              {members === undefined ? (
                <div className="card h-40 animate-pulse" />
              ) : list.length === 0 ? (
                <div className="card text-center text-sm text-muted">
                  {filter === 'pending' ? 'Nobody is waiting for approval.' : 'No members here yet.'}
                </div>
              ) : (
                <ul className="card divide-y divide-line !p-0">
                  {list.map((m) => (
                    <li key={m.uid}>
                      <button onClick={() => setSelected(m)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                        <Avatar src={m.photoURL} name={m.fullName} size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-bold">{m.fullName}</p>
                          <p className="text-xs text-muted">{m.stateCode}</p>
                        </div>
                        {m.role === 'exco' && <Pill>Exco</Pill>}
                        {m.status === 'pending' && <Pill tone="warn">Pending</Pill>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <Link to="/exco/cards" className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-card font-bold text-green shadow-card">
                <Icon name="print" /> Print QR cards (for members without smartphones)
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
        <ErrorBox>{error}</ErrorBox>
      </Page>
    </>
  );
}
