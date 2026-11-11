import QrScanner from 'qr-scanner';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from './ui';

interface Props {
  onResult: (text: string) => void;
  /** Stop reacting to codes (e.g. while a result card is showing). */
  paused?: boolean;
  className?: string;
}

/** Live camera QR scanner. Same code is ignored for 3 seconds so one scan = one action. */
export function QRScan({ onResult, paused = false, className = '' }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cb = useRef(onResult);
  const pausedRef = useRef(paused);
  const last = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const scannerRef = useRef<QrScanner | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'on' | 'error'>('idle');
  const [error, setError] = useState('');

  cb.current = onResult;
  pausedRef.current = paused;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const scanner = new QrScanner(
      video,
      (r) => {
        if (pausedRef.current) return;
        const now = Date.now();
        if (r.data === last.current.text && now - last.current.at < 3000) return;
        last.current = { text: r.data, at: now };
        navigator.vibrate?.(60);
        cb.current(r.data);
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        preferredCamera: 'environment',
        maxScansPerSecond: 6,
      },
    );
    scannerRef.current = scanner;
    return () => {
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
  }, []);

  async function startCamera() {
    if (!window.isSecureContext) {
      setState('error');
      setError('Camera access requires HTTPS. Open the secure CDS Pass website, or type the door code.');
      return;
    }
    setState('starting');
    setError('');
    try {
      await scannerRef.current?.start();
      setState('on');
    } catch (e) {
      setState('error');
      const err = e as { name?: string; message?: string };
      const msg = `${err.name ?? ''} ${err.message ?? e}`;
      setError(
        /NotAllowed|permission|denied/i.test(msg)
          ? 'Camera permission is blocked. Allow camera access for this website in your browser settings, then try again.'
          : /NotFound/i.test(msg)
            ? 'No camera was found on this device. Type the door code instead.'
            : /NotReadable|TrackStart/i.test(msg)
              ? 'The camera is busy in another app. Close that app and try again.'
              : `Could not open the camera. Check this site’s camera permission and try again. ${err.message ?? ''}`.trim(),
      );
    }
  }

  return (
    <div className={`relative mx-auto max-w-[480px] overflow-hidden rounded-3xl bg-green-deep ${className}`}>
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
      {state === 'starting' && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner light size={32} />
        </div>
      )}
      {state !== 'on' && state !== 'starting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm font-semibold text-white">
          <p>{state === 'error' ? error : 'Tap below to let CDS Pass open your camera.'}</p>
          <button type="button" onClick={() => void startCamera()} className="rounded-xl bg-white px-5 py-3 font-bold text-green">
            {state === 'error' ? 'Try camera again' : 'Open camera'}
          </button>
        </div>
      )}
    </div>
  );
}
