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
type Sort = 'name' | 'newest' | 'code';

/** "LA/26B/1142" → "26B" (the NYSC batch). */
const batchOf = (stateCode: string) => stateCode.split('/')[1] ?? '';
const timeOf = (m: Profile) => {
  const t = (m as unknown as { createdAt?: { toMillis?: () => number } }).createdAt;
  return typeof t?.toMillis === 'function' ? t.toMillis() : 0;
};

export default function Members() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const members = useGroupMembers(me.groupId);
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  const [filter, setFilter] = useState<Filter>('pending');
  const [search, setSearch] = useState('');
  const [batch, setBatch] = useState<string>('all');
  const [noPhotoOnly, setNoPhotoOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('name');
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

  // Members in the current tab, before the batch / photo filters (used for the chip counts).
  const inTab = useMemo(
    () =>
      (members ?? []).filter((m) =>
        filter === 'pending' ? m.status === 'pending' : filter === 'excos' ? m.role === 'exco' : m.status === 'approved',
      ),
    [members, filter],
  );

  // Batches that actually exist in this tab, e.g. [["26A", 12], ["26B", 30]].
  const batches = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of inTab) {
      const b = batchOf(m.stateCode);
      if (b) c.set(b, (c.get(b) ?? 0) + 1);
    }
    return [...c.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [inTab]);

  const list = useMemo(() => {
    // Search ignores slashes and spaces, so "26b1142", "26B/1142" and "1142" all find LA/26B/1142.
    const q = search.trim().toLowerCase().replace(/[\s/-]/g, '');
    const rows = inTab
      .filter((m) => batch === 'all' || batchOf(m.stateCode) === batch)
      .filter((m) => !noPhotoOnly || !m.photoURL)
      .filter(
        (m) =>
          !q ||
          m.fullName.toLowerCase().replace(/\s/g, '').includes(q) ||
          m.stateCode.toLowerCase().replace(/[\s/-]/g, '').includes(q) ||
          (m.phone ?? '').replace(/\D/g, '').includes(q.replace(/^0/, '')),
      );
    return [...rows].sort((a, b) =>
      sort === 'newest' ? timeOf(b) - timeOf(a) : sort === 'code' ? a.stateCode.localeCompare(b.stateCode, undefined, { numeric: true }) : a.fullName.localeCompare(b.fullName),
    );
  }, [inTab, batch, noPhotoOnly, search, sort]);

  const filtersOn = batch !== 'all' || noPhotoOnly || search.trim() !== '';

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
                <input className="input flex-1" placeholder="Search name, state code or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />
                <button onClick={() => setScanning(true)} aria-label="Scan member code" className="grid h-14 w-14 place-items-center rounded-2xl bg-green text-white">
                  <Icon name="scan" />
                </button>
              </div>

              {/* Batch chips (26A, 26B, 26C …), no-photo filter and sort */}
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                {[['all', inTab.length] as [string, number], ...batches].map(([b, n]) => (
                  <button
                    key={b}
                    onClick={() => setBatch(b)}
                    className={`relative h-10 shrink-0 rounded-full px-4 text-sm font-bold transition-colors ${
                      batch === b ? 'text-white' : 'bg-card text-ink shadow-card'
                    }`}
                  >
                    {batch === b && <motion.span layoutId="batch-chip" className="absolute inset-0 rounded-full bg-green" />}
                    <span className="relative">
                      {b === 'all' ? 'All batches' : `Batch ${b}`} <span className="opacity-70">{n}</span>
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => setNoPhotoOnly((v) => !v)}
                  className={`h-10 shrink-0 rounded-full px-4 text-sm font-bold ${noPhotoOnly ? 'bg-warn text-white' : 'bg-card text-warn shadow-card'}`}
                >
                  No photo
                </button>
              </div>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted">
                  {list.length} {list.length === 1 ? 'person' : 'people'}
                  {filtersOn && (
                    <button
                      onClick={() => {
                        setBatch('all');
                        setNoPhotoOnly(false);
                        setSearch('');
                      }}
                      className="ml-2 font-bold text-green"
                    >
                      Clear filters
                    </button>
                  )}
                </span>
                <select
                  aria-label="Sort members"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as Sort)}
                  className="h-10 rounded-xl border border-line bg-card px-3 font-bold text-ink"
                >
                  <option value="name">Name A–Z</option>
                  <option value="code">State code</option>
                  <option value="newest">Newest first</option>
                </select>
              </div>

              {members === undefined ? (
                <div className="card h-40 animate-pulse" />
              ) : list.length === 0 ? (
                <div className="card text-center text-sm text-muted">
                  {filtersOn ? 'Nobody matches these filters.' : filter === 'pending' ? 'Nobody is waiting for approval.' : 'No members here yet.'}
                </div>
              ) : (
                <ul className="card divide-y divide-line !p-0">
                  {list.map((m) => (
                    <li key={m.uid}>
                      <button onClick={() => setSelected(m)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                        <Avatar src={m.photoURL} name={m.fullName} size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-bold">{m.fullName}</p>
                          <p className="text-xs text-muted">
                            {m.stateCode}
                            {!m.photoURL && <span className="font-bold text-warn"> · No photo yet</span>}
                          </p>
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
