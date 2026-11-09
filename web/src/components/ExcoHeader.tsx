import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './ui';

export function ExcoHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="grid-bg bg-green-dark px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] text-white lg:rounded-[28px] lg:px-7 lg:pb-6 lg:pt-6">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-extrabold tracking-[0.2em] text-green-mid">EXCO</p>
          <h1 className="truncate text-xl font-extrabold">{title}</h1>
          {sub && <p className="truncate text-xs font-semibold text-green-mid">{sub}</p>}
        </div>
        <div className="flex gap-2">
          <Link to="/home" aria-label="My own tag" className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
            <Icon name="tag" size={20} />
          </Link>
          <Link to="/exco/settings" aria-label="Settings" className="grid h-11 w-11 place-items-center rounded-full bg-white/10">
            <Icon name="settings" size={20} />
          </Link>
        </div>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}
