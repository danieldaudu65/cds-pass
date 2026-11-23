import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useMyMemberships } from '../hooks/useLive';
import { api } from '../lib/api';
import { errorText } from '../lib/firebase';
import { toast } from '../lib/toast';
import { Button, ErrorBox, Pill } from './ui';

/**
 * "My CDS groups": see every CDS you're in (e.g. Horticulture + General CDS), switch between them,
 * or add another one with its 6-character code.
 */
export function MyGroups({ compact = false, onlyIfSeveral = false }: { compact?: boolean; onlyIfSeveral?: boolean }) {
  const { user, profile, refreshClaims } = useAuth();
  const nav = useNavigate();
  const groups = useMyMemberships(user?.uid);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function switchTo(gid: string, name: string) {
    setError('');
    setBusy(gid);
    try {
      const r = await api.switchGroup({ gid });
      await refreshClaims();
      toast(`Now using ${name}`, 'success');
      nav(r.status === 'approved' ? (r.role === 'exco' ? '/exco' : '/home') : '/pending', { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function join() {
    setError('');
    if (code.trim().length !== 6) return setError('Enter the 6-character group code.');
    setBusy('join');
    try {
      const r = await api.joinAnotherGroup({ joinCode: code.trim().toUpperCase() });
      toast(
        r.status === 'approved' ? `You joined ${r.groupName}` : `Request sent to ${r.groupName}`,
        'success',
        r.status === 'approved' ? 'Switch to it below.' : 'An exco of that group will approve you.',
      );
      setCode('');
      setAdding(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function leave(gid: string, name: string) {
    if (!confirm(`Leave ${name}?`)) return;
    setBusy(`leave:${gid}`);
    try {
      await api.leaveGroup({ gid });
      toast(`You left ${name}`, 'info');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  // On "Under review": only useful if you're in another group you can switch back to.
  if (onlyIfSeveral && (groups?.length ?? 0) < 2) return null;

  const sorted = (groups ?? []).slice().sort((a, b) => Number(b.gid === profile?.groupId) - Number(a.gid === profile?.groupId));

  return (
    <div className={compact ? 'space-y-3' : 'card space-y-3'}>
      <div>
        <p className="font-bold">My CDS groups</p>
        {!compact && <p className="text-sm text-muted">Joined General CDS or another group too? Add it here and switch between them.</p>}
      </div>

      {groups === undefined ? (
        <div className="h-14 animate-pulse rounded-2xl bg-line" />
      ) : (
        <ul className="space-y-2">
          {sorted.map((m) => {
            const current = m.gid === profile?.groupId;
            return (
              <li
                key={m.gid}
                className={`flex items-center gap-3 rounded-2xl p-3 ${current ? 'bg-green-light' : 'bg-paper'}`}
              >
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl font-display text-sm font-extrabold ${current ? 'bg-green text-white' : 'bg-card text-green shadow-card'}`}>
                  {(m.groupName || 'CDS').slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{m.groupName || 'CDS group'}</span>
                  <span className="block text-xs text-muted">
                    {m.role === 'exco' ? 'Exco' : 'Member'} ·{' '}
                    {m.status === 'approved' ? 'Approved' : m.status === 'pending' ? 'Waiting for approval' : 'Not approved'}
                  </span>
                </span>
                {current ? (
                  <Pill>Using now</Pill>
                ) : m.status === 'rejected' ? (
                  <button disabled={busy === `leave:${m.gid}`} onClick={() => leave(m.gid, m.groupName)} className="text-xs font-bold text-bad">
                    Remove
                  </button>
                ) : (
                  <button
                    disabled={!!busy}
                    onClick={() => switchTo(m.gid, m.groupName)}
                    className="h-9 shrink-0 rounded-xl bg-green px-3 text-xs font-bold text-white disabled:opacity-50"
                  >
                    {busy === m.gid ? '…' : 'Switch'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AnimatePresence initial={false}>
        {adding ? (
          <motion.div key="add" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-2 overflow-hidden">
            <input
              className="input text-center text-xl font-extrabold tracking-[0.35em]"
              placeholder="GROUP CODE"
              maxLength={6}
              autoCapitalize="characters"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              aria-label="Group code"
            />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button loading={busy === 'join'} onClick={join}>
                Join
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="btn" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Button variant="ghost" onClick={() => setAdding(true)}>
              + Add another CDS
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      <ErrorBox>{error}</ErrorBox>
    </div>
  );
}
