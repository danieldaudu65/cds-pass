import { useEffect, useState } from 'react';
import { api, type PlatformRole } from '../lib/api';
import { useAuth } from './useAuth';

/** The admin-team role for the logged-in user (null for normal users). Asked once per login. */
let cache: { uid: string; role: PlatformRole | null } | null = null;

export function usePlatformRole(): PlatformRole | null {
  const { user } = useAuth();
  const [role, setRole] = useState<PlatformRole | null>(cache && user && cache.uid === user.uid ? cache.role : null);
  useEffect(() => {
    if (!user) return;
    const known = cache;
    if (known && known.uid === user.uid) {
      setRole(known.role);
      return;
    }
    let live = true;
    api
      .adminWhoAmI({})
      .then((r) => {
        cache = { uid: user.uid, role: r.role };
        if (live) setRole(r.role);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [user]);
  return role;
}

/** Public app status: banner + maintenance (fetched once, never blocks the app). */
type Status = Awaited<ReturnType<typeof api.appStatus>>;
let statusPromise: Promise<Status> | null = null;

export function useAppStatus(): Status | null {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    statusPromise ??= api.appStatus({});
    let live = true;
    statusPromise.then((v) => live && setS(v)).catch(() => (statusPromise = null));
    return () => {
      live = false;
    };
  }, []);
  return s;
}
