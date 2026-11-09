import { useSyncExternalStore } from 'react';

/** Chrome / Edge / Samsung Internet fire this when the site can be installed. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

/** Call once, as early as possible, so the browser's install offer isn't missed. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    emit();
  });
  window.matchMedia('(display-mode: standalone)').addEventListener('change', emit);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export type Platform = 'ios' | 'android' | 'inapp' | 'desktop';

export function platform(): Platform {
  const ua = navigator.userAgent;
  // WhatsApp, Instagram, Facebook, X etc. open links in their own browser, which can't install apps.
  if (/FBAN|FBAV|Instagram|WhatsApp|Twitter|Line\/|MicroMessenger|; wv\)/i.test(ua)) return 'inapp';
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || iPadOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/**
 * Phones must use the installed app. Laptops can use the website as-is.
 * Not enforced while developing (npm run dev) or on plain http, where installing is impossible.
 */
export function mustInstall(): boolean {
  if (import.meta.env.DEV) return false;
  if (!window.isSecureContext) return false;
  return platform() !== 'desktop' && !isStandalone();
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  emit();
  return outcome === 'accepted';
}

export function useInstallState() {
  const snap = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => `${!!deferred}|${installed}|${isStandalone()}`,
  );
  const [canPrompt, justInstalled, standalone] = snap.split('|').map((x) => x === 'true');
  return { canPrompt, justInstalled, standalone };
}
