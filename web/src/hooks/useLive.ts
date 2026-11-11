import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type Query,
} from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/firebase';
import { api } from '../lib/api';
import { lagosDate } from '../lib/rules';
import type { Attendee, Dues, DuesStatus, Group, LogEntry, Payment, Profile, Session } from '../lib/types';

/** Live document. undefined = loading, null = does not exist. */
export function useDoc<T>(path: string | null): T | null | undefined {
  const [val, setVal] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    if (!path) return setVal(null);
    setVal(undefined);
    return onSnapshot(
      doc(db, path),
      (s) => setVal(s.exists() ? ({ id: s.id, ...s.data() } as T) : null),
      (e) => {
        console.warn(path, e);
        setVal(null);
      },
    );
  }, [path]);
  return val;
}

/** Live list. undefined = loading. */
export function useList<T>(q: Query<DocumentData> | null, key: string): T[] | undefined {
  const [val, setVal] = useState<T[] | undefined>(undefined);
  useEffect(() => {
    if (!q) return setVal([]);
    setVal(undefined);
    return onSnapshot(
      q,
      (s) => setVal(s.docs.map((d) => ({ id: d.id, uid: d.id, ...d.data() }) as T)),
      (e) => {
        console.warn(key, e);
        setVal([]);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return val;
}

/** Today's date in Lagos, refreshed every minute so the app rolls over at midnight. */
export function useToday(): string {
  const [d, setD] = useState(lagosDate());
  useEffect(() => {
    const t = setInterval(() => setD(lagosDate()), 60_000);
    return () => clearInterval(t);
  }, []);
  return d;
}

export const useGroup = (gid: string | undefined) => useDoc<Group>(gid ? `groups/${gid}` : null);

export function useSession(gid: string | undefined) {
  const today = useToday();
  return useDoc<Session>(gid ? `groups/${gid}/sessions/${today}` : null);
}

export function useMyAttendee(gid: string | undefined, uid: string | undefined) {
  const today = useToday();
  return useDoc<Attendee>(gid && uid ? `groups/${gid}/sessions/${today}/attendees/${uid}` : null);
}

export function useAttendees(gid: string | undefined) {
  const today = useToday();
  const q = useMemo(
    () => (gid ? query(collection(db, `groups/${gid}/sessions/${today}/attendees`)) : null),
    [gid, today],
  );
  const list = useList<Attendee>(q, `att:${gid}:${today}`);
  return useMemo(
    () =>
      list?.slice().sort((a, b) => {
        if (a.priority !== b.priority) return a.priority ? -1 : 1;
        if (a.priority && b.priority) return (a.pNumber ?? 0) - (b.pNumber ?? 0);
        return a.number - b.number;
      }),
    [list],
  );
}

export function useGroupMembers(gid: string | undefined) {
  const q = useMemo(() => (gid ? query(collection(db, 'users'), where('groupId', '==', gid)) : null), [gid]);
  const list = useList<Profile>(q, `members:${gid}`);
  return useMemo(() => list?.slice().sort((a, b) => a.fullName.localeCompare(b.fullName)), [list]);
}

export function useLogs(gid: string | undefined, max = 50) {
  const [logs, setLogs] = useState<LogEntry[] | undefined>(undefined);
  useEffect(() => {
    if (!gid) {
      setLogs([]);
      return;
    }
    let active = true;
    setLogs(undefined);
    void api.getLogs({ limit: max }).then((entries) => {
      if (active) setLogs(entries);
    }).catch((error) => {
      console.error('Could not load activity history.', error);
      if (active) setLogs([]);
    });
    return () => { active = false; };
  }, [gid, max]);
  return logs;
}

export function useActiveDues(gid: string | undefined) {
  const q = useMemo(() => (gid ? query(collection(db, `groups/${gid}/dues`), where('active', '==', true)) : null), [gid]);
  const list = useList<Dues>(q, `dues:${gid}`);
  return useMemo(() => list?.slice().sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)), [list]);
}

export function useDuesStatuses(gid: string | undefined, duesId: string | undefined) {
  const q = useMemo(
    () => (gid && duesId ? query(collection(db, `groups/${gid}/dues/${duesId}/status`)) : null),
    [gid, duesId],
  );
  return useList<DuesStatus>(q, `duesStatus:${gid}:${duesId}`);
}

export function useMyPayments(gid: string | undefined, uid: string | undefined) {
  const q = useMemo(
    () => (gid && uid ? query(collection(db, `groups/${gid}/payments`), where('uid', '==', uid)) : null),
    [gid, uid],
  );
  const list = useList<Payment>(q, `pay:${gid}:${uid}`);
  return useMemo(
    () =>
      list
        ?.filter((p) => p.status === 'paid')
        .sort((a, b) => (b.paidAt?.toMillis() ?? 0) - (a.paidAt?.toMillis() ?? 0)),
    [list],
  );
}
