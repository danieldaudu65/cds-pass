import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { auth, db } from '../lib/firebase';
import type { Profile } from '../lib/types';

interface Claims {
  gid?: string;
  role?: 'member' | 'exco';
  approved?: boolean;
}

interface AuthState {
  /** undefined = still loading */
  user: User | null | undefined;
  /** undefined = loading, null = account exists but registration not finished */
  profile: Profile | null | undefined;
  /** A read failure is different from a profile that does not exist. */
  profileError: string | null;
  claims: Claims;
  /** true when the login token already carries the approval (needed for reading group data) */
  ready: boolean;
  refreshClaims: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [claims, setClaims] = useState<Claims>({});

  const refreshClaims = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) return setClaims({});
    const t = await u.getIdTokenResult(true);
    setClaims({ gid: t.claims.gid as string, role: t.claims.role as Claims['role'], approved: t.claims.approved === true });
  }, []);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        setUser(u);
        if (!u) {
          setProfile(null);
          setProfileError(null);
          setClaims({});
          return;
        }
        // A login saved in the browser can point to an account that no longer exists
        // (deleted, or the local test server was restarted). Log out instead of getting stuck.
        try {
          await u.reload();
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === 'auth/user-not-found' || code === 'auth/user-token-expired' || code === 'auth/user-disabled') {
            await signOut(auth);
            return;
          }
        }
        const t = await u.getIdTokenResult();
        setClaims({ gid: t.claims.gid as string, role: t.claims.role as Claims['role'], approved: t.claims.approved === true });
      }),
    [],
  );

  useEffect(() => {
    if (!user) {
      setProfileError(null);
      return;
    }
    setProfile(undefined);
    setProfileError(null);
    return onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        setProfileError(null);
        setProfile(snap.exists() ? ({ uid: snap.id, ...snap.data() } as Profile) : null);
      },
      (error) => {
        console.error('Could not load the signed-in user profile:', error);
        setProfile(undefined);
        setProfileError(error.message || 'Could not read your CDS profile.');
      },
    );
  }, [user]);

  // When an exco approves you (or changes your role), pick up the new permissions.
  useEffect(() => {
    if (!profile) return;
    const approved = profile.status === 'approved';
    if (approved !== !!claims.approved || (approved && profile.role !== claims.role)) {
      void refreshClaims();
    }
  }, [profile, claims.approved, claims.role, refreshClaims]);

  const ready =
    !!profile && profile.status === 'approved' && claims.approved === true && claims.role === profile.role;

  const logout = useCallback(async () => {
    await signOut(auth);
  }, []);

  return <Ctx.Provider value={{ user, profile, profileError, claims, ready, refreshClaims, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

/** For screens that only render once signed in and approved. */
export function useMe(): Profile {
  const { profile } = useAuth();
  if (!profile) throw new Error('useMe used before profile loaded');
  return profile;
}
