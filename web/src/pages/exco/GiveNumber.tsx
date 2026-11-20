import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Icon, Page, Pill } from '../../components/ui';
import { useExcoDay } from '../../hooks/useExco';
import { useGroupMembers } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { tagLabel } from '../../lib/rules';
import { toast } from '../../lib/toast';
import type { Profile } from '../../lib/types';

/**
 * Main exco only: give a registered member the next number when their phone is off / dead.
 * Search, tap the person, confirm. The door code changes straight after.
 */
export default function GiveNumber() {
  const { me, group, open, attendees } = useExcoDay();
  const members = useGroupMembers(me.groupId);
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [given, setGiven] = useState<{ name: string; number: number } | null>(null);

  const byUid = useMemo(() => new Map((attendees ?? []).map((a) => [a.uid, a])), [attendees]);
  const list = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/[\s/-]/g, '');
    if (!q) return [];
    return (members ?? [])
      .filter((m) => m.status === 'approved')
      .filter((m) => m.fullName.toLowerCase().replace(/\s/g, '').includes(q) || m.stateCode.toLowerCase().replace(/[\s/-]/g, '').includes(q))
      .slice(0, 20);
  }, [members, search]);

  async function give() {
    if (!picked) return;
    setError('');
    setBusy(true);
    try {
      const r = await api.giveNextNumber({ uid: picked.uid });
      navigator.vibrate?.([60, 40, 60]);
      setGiven({ name: picked.fullName, number: r.number });
      toast(r.already ? `${picked.fullName} already has No. ${r.number}` : `${picked.fullName} is No. ${r.number}`, 'success', 'The door code has changed.');
      setPicked(null);
      setSearch('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ExcoHeader title="Give a number" sub="For registered members whose phone is off" />
      <Page className="space-y-4">
        {group && !isMainExco ? (
          <div className="card text-center text-sm text-muted">Only the main exco can give numbers by hand.</div>
        ) : !open ? (
          <div className="card text-center">
            <p className="font-bold">Today's meeting is not open</p>
            <Link to="/exco" className="mt-3 inline-block font-bold text-green">
              Open it from Today →
            </Link>
          </div>
        ) : (
          <>
            <AnimatePresence>
              {given && (
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="number-card rounded-[28px] p-5 text-center text-white"
                >
                  <p className="text-sm text-green-mid">{given.name}</p>
                  <p className="font-display text-7xl font-extrabold">{given.number}</p>
                  <p className="text-xs text-green-mid">Tell them their number. The door code has changed.</p>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="card space-y-3">
              <input
                className="input"
                autoFocus
                placeholder="Search name or state code"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPicked(null);
                  setGiven(null);
                }}
                aria-label="Search members"
              />
              {!search && <p className="text-sm text-muted">Type a name or state code (e.g. 26B/1142) to find the person.</p>}
              {search && members === undefined && <div className="h-14 animate-pulse rounded-2xl bg-line" />}
              {search && members && list.length === 0 && <p className="text-sm text-muted">No approved member matches.</p>}
              <ul className="divide-y divide-line">
                {list.map((m) => {
                  const a = byUid.get(m.uid);
                  return (
                    <li key={m.uid}>
                      <button
                        onClick={() => setPicked(m)}
                        className={`flex w-full items-center gap-3 rounded-2xl px-2 py-3 text-left ${picked?.uid === m.uid ? 'bg-green-light' : ''}`}
                      >
                        <Avatar src={m.photoURL} name={m.fullName} size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold">{m.fullName}</p>
                          <p className="text-xs text-muted">{m.stateCode}</p>
                        </div>
                        {a ? <Pill>No. {tagLabel(a)}</Pill> : <Pill tone="muted">No number</Pill>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <AnimatePresence>
              {picked && (
                <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} className="card space-y-3">
                  <div className="flex items-center gap-3">
                    <Avatar src={picked.photoURL} name={picked.fullName} size={64} />
                    <div className="min-w-0">
                      <p className="font-display text-lg font-extrabold">{picked.fullName}</p>
                      <p className="text-sm text-muted">{picked.stateCode}</p>
                    </div>
                  </div>
                  <p className="rounded-2xl bg-gold-bg px-4 py-3 text-sm text-gold-text">Check their NYSC ID card matches this photo before you give a number.</p>
                  <ErrorBox>{error}</ErrorBox>
                  {byUid.get(picked.uid) ? (
                    <p className="text-center font-bold text-green">Already has No. {tagLabel(byUid.get(picked.uid)!)}</p>
                  ) : (
                    <Button loading={busy} onClick={give}>
                      <Icon name="check" /> Give next number
                    </Button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </Page>
    </>
  );
}
