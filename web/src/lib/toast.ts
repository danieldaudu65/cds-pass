export type ToastKind = 'info' | 'success' | 'error';
export interface ToastItem {
  id: number;
  title: string;
  body?: string;
  kind: ToastKind;
}

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit() {
  listeners.forEach((l) => l(items));
}

export function toast(title: string, kind: ToastKind = 'info', body?: string) {
  const id = nextId++;
  items = [...items, { id, title, body, kind }].slice(-3);
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 4000);
}

export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(l: Listener) {
  listeners.add(l);
  l(items);
  return () => {
    listeners.delete(l);
  };
}
