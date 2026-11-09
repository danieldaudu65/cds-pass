import { useSyncExternalStore } from 'react';

/**
 * While sign-up is running, the account exists before the profile does.
 * This lock keeps the sign-up screen on screen until everything is saved.
 */
export type SignupLock = false | 'signup' | 'finish';
let locked: SignupLock = false;
const subs = new Set<() => void>();

export function setSignupLock(v: SignupLock) {
  locked = v;
  subs.forEach((s) => s());
}

export function useSignupLock(): SignupLock {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => locked,
  );
}
