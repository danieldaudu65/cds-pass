import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { dismiss, subscribeToasts, type ToastItem } from '../lib/toast';

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribeToasts(setItems), []);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 mx-auto flex max-w-md flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]" aria-live="polite">
      <AnimatePresence>
        {items.map((t) => (
          <motion.button
            key={t.id}
            layout
            initial={{ opacity: 0, y: -30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto rounded-2xl px-4 py-3 text-left shadow-lift ${
              t.kind === 'error' ? 'bg-bad text-white' : t.kind === 'success' ? 'bg-green text-white' : 'bg-ink text-white'
            }`}
          >
            <p className="font-bold">{t.title}</p>
            {t.body ? <p className="text-sm opacity-90">{t.body}</p> : null}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
