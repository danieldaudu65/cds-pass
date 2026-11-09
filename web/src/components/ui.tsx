import { motion, type HTMLMotionProps } from 'framer-motion';
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger' | 'light';

const variants: Record<Variant, string> = {
  primary: 'bg-green text-white shadow-[0_8px_0_#064726] active:shadow-[0_3px_0_#064726] active:translate-y-[5px]',
  outline: 'border-2 border-green bg-card text-green',
  ghost: 'bg-green-light text-green',
  danger: 'bg-bad text-white shadow-[0_8px_0_#7A1810] active:shadow-[0_3px_0_#7A1810] active:translate-y-[5px]',
  light: 'bg-card text-green shadow-[0_8px_0_rgb(var(--line))] active:shadow-[0_3px_0_rgb(var(--line))] active:translate-y-[5px]',
};

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  loading?: boolean;
  children: ReactNode;
  full?: boolean;
}

/** Chunky 3D-press button. */
export function Button({ variant = 'primary', loading, children, full = true, className = '', disabled, ...rest }: ButtonProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      disabled={disabled || loading}
      className={`flex h-14 items-center justify-center gap-2 rounded-2xl px-5 text-base font-bold transition-[transform,box-shadow] disabled:opacity-50 ${
        full ? 'w-full' : ''
      } ${variants[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner light={variant === 'primary' || variant === 'danger'} /> : children}
    </motion.button>
  );
}

export function Spinner({ light = false, size = 22 }: { light?: boolean; size?: number }) {
  return (
    <motion.span
      aria-label="Loading"
      role="status"
      className={`inline-block rounded-full border-[3px] ${light ? 'border-white/30 border-t-white' : 'border-green/20 border-t-green'}`}
      style={{ width: size, height: size }}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
    />
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, error, id, ...rest }, ref) {
  const fid = id ?? `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div>
      <label htmlFor={fid} className="label">
        {label}
      </label>
      <input ref={ref} id={fid} className={`input ${error ? 'border-bad' : ''}`} {...rest} />
      {error ? (
        <p className="mt-1.5 text-sm font-semibold text-bad">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-muted">{hint}</p>
      ) : null}
    </div>
  );
});

export function ErrorBox({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <motion.p
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      role="alert"
      className="rounded-2xl bg-bad-bg px-4 py-3 text-sm font-semibold text-bad"
    >
      {children}
    </motion.p>
  );
}

export function Pill({ children, tone = 'green' }: { children: ReactNode; tone?: 'green' | 'warn' | 'bad' | 'muted' | 'white' }) {
  const tones = {
    green: 'bg-green-light text-green',
    warn: 'bg-warn-bg text-warn',
    bad: 'bg-bad-bg text-bad',
    muted: 'bg-line text-muted',
    white: 'bg-white/15 text-white',
  } as const;
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${tones[tone]}`}>{children}</span>;
}

/** Green top bar with optional back button. */
export function TopBar({ title, back, right, sub }: { title: string; back?: string | true; right?: ReactNode; sub?: string }) {
  const nav = useNavigate();
  return (
    <header className="sticky top-0 z-20 bg-green-dark/95 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-white backdrop-blur lg:top-4 lg:rounded-3xl lg:px-6 lg:pt-4">
      <div className="flex items-center gap-3">
        {back ? (
          typeof back === 'string' ? (
            <Link to={back} aria-label="Back" className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
              <Icon name="back" />
            </Link>
          ) : (
            <button aria-label="Back" onClick={() => nav(-1)} className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
              <Icon name="back" />
            </button>
          )
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-extrabold">{title}</h1>
          {sub ? <p className="truncate text-xs font-medium text-green-mid">{sub}</p> : null}
        </div>
        {right}
      </div>
    </header>
  );
}

/** Page wrapper with a soft slide-in. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.main
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ type: 'spring', stiffness: 260, damping: 28 }}
      className={`flex-1 px-4 pb-28 pt-4 lg:px-0 lg:pb-10 lg:pt-6 ${className}`}
    >
      {children}
    </motion.main>
  );
}

export function Stat({ value, label, tone = 'dark' }: { value: ReactNode; label: string; tone?: 'dark' | 'light' }) {
  return (
    <div className={`rounded-2xl p-3 ${tone === 'dark' ? 'bg-white/10 text-white' : 'bg-white text-ink shadow-card'}`}>
      <div className="text-2xl font-extrabold leading-tight">{value}</div>
      <div className={`text-xs font-semibold ${tone === 'dark' ? 'text-green-mid' : 'text-muted'}`}>{label}</div>
    </div>
  );
}

const paths: Record<string, ReactNode> = {
  back: <path d="m15 18-6-6 6-6" />,
  home: <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  scan: (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </>
  ),
  tag: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M9 8h6M8 16h8M10 12h4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 9M22 21a7 7 0 0 0-4-6.3" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  door: (
    <>
      <path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M2 21h20" />
      <circle cx="12.5" cy="12" r="1" />
    </>
  ),
  megaphone: (
    <>
      <path d="m3 11 15-6v14L3 13z" />
      <path d="M7 13v5a2 2 0 0 0 4 0v-3.5" />
    </>
  ),
  finger: <path d="M12 11v3m-4-4a4 4 0 0 1 8 0v4a8 8 0 0 1-1 4M5 8a8 8 0 0 1 14 0m-3 12a12 12 0 0 0 1-6M8 14a4 4 0 0 0 1 3" />,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  pin: (
    <>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  keypad: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" />
    </>
  ),
  print: (
    <>
      <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="3" />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  cash: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  bank: <path d="M3 10h18L12 4zM5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 22, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}
