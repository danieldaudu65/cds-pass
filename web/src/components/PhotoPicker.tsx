import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { compressPhoto } from '../lib/image';
import { Icon } from './ui';

/** Take a selfie or choose a photo. Returns a small, square JPEG. */
export function PhotoPicker({
  value,
  currentPhotoURL,
  onChange,
}: {
  value: Blob | null;
  currentPhotoURL?: string | null;
  onChange: (b: Blob | null, err?: string) => void;
}) {
  const cam = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return setPreview(null);
    const url = URL.createObjectURL(value);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  async function pick(f: File | undefined) {
    if (!f) return;
    try {
      onChange(await compressPhoto(f));
    } catch (e) {
      onChange(null, (e as Error).message);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <motion.div
        initial={{ scale: 0.9, rotate: -4 }}
        animate={{ scale: 1, rotate: 0 }}
        className="relative h-40 w-40 overflow-hidden rounded-full bg-green-light shadow-lift ring-8 ring-white"
      >
        {preview || currentPhotoURL ? (
          <img src={preview ?? currentPhotoURL ?? undefined} alt="Your profile" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-green">
            <Icon name="user" size={64} />
          </div>
        )}
      </motion.div>
      <p className="max-w-xs text-center text-sm text-muted">
        Use a clear photo of your face. The exco compares it with your NYSC ID card.
      </p>
      <div className="grid w-full grid-cols-2 gap-3">
        <button type="button" onClick={() => cam.current?.click()} className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-green font-bold text-white">
          <Icon name="camera" /> Take photo
        </button>
        <button type="button" onClick={() => gallery.current?.click()} className="flex h-14 items-center justify-center gap-2 rounded-2xl border-2 border-green bg-card font-bold text-green">
          Choose photo
        </button>
      </div>
      <input ref={cam} type="file" accept="image/*" capture="user" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <input ref={gallery} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}
