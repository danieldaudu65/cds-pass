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
  const [state, setState] = useState<'starting' | 'on' | 'error'>('starting');
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
    scanner
      .start()
      .then(() => setState('on'))
      .catch((e: unknown) => {
        setState('error');
        const msg = String((e as Error)?.message ?? e);
        setError(
          /permission|denied|NotAllowed/i.test(msg)
            ? 'Camera permission is blocked. Allow the camera in your browser settings, or type the code instead.'
            : 'Could not open the camera on this phone. Type the code instead.',
        );
      });
    return () => {
      scanner.stop();
      scanner.destroy();
    };
  }, []);

  return (
    <div className={`relative mx-auto max-w-[480px] overflow-hidden rounded-3xl bg-green-deep ${className}`}>
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
      {state === 'starting' && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner light size={32} />
        </div>
      )}
      {state === 'error' && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm font-semibold text-white">{error}</div>
      )}
    </div>
  );
}
