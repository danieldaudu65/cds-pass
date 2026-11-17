/** Public browser configuration for CDS Pass. These values are bundled into the frontend. */
const liveFirebaseConfig = {"apiKey":"AIzaSyAsuZMiSs6Qgu2p6fpQCzPXrYR_a1q9K8E","authDomain":"cds-pass.firebaseapp.com","projectId":"cds-pass","storageBucket":"cds-pass.firebasestorage.app","messagingSenderId":"214017403181","appId":"1:214017403181:web:92cf6330c143c58b10cba4"};
// Used to show the group-creation option. The server separately verifies the signed-in account.
export const PLATFORM_ADMIN_STATE_CODE = 'LA/26B/2578';
const LIVE_API_URL = 'https://cds-pass.onrender.com';
export const VAPID_KEY = 'BAkiu3AGhJLUKS4KCKSO7sbohw_VPIBV4zN80yJjiyEHiESvtsQuldI_BAzyefepYlAo_-OACNwMkmGu_auIAl4';
export const SERVICE_FEE_PERCENT = 3;
export const PAYSTACK_FEE_PERCENT = 1.5;

/**
 * Safe local testing. Only when you run `npm run dev` AND web/.env has VITE_USE_EMULATORS=true,
 * the site talks to the Firebase emulators and the server on your PC (no real data, no real money).
 * A production build (`npm run build`) ALWAYS uses the live values above.
 */
export const USE_EMULATORS = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === 'true';

export const firebaseConfig = USE_EMULATORS
  ? { ...liveFirebaseConfig, apiKey: 'demo-key', projectId: 'demo-cds-pass', authDomain: 'demo-cds-pass.firebaseapp.com' }
  : liveFirebaseConfig;

export const API_URL = USE_EMULATORS ? 'http://localhost:8787' : LIVE_API_URL;
