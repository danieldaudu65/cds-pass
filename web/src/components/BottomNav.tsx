import { motion } from 'framer-motion';
import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from './ui';

export const memberTabs: { to: string; label: string; icon: IconName }[] = [
  { to: '/home', label: 'Home', icon: 'home' },
  { to: '/scan', label: 'Scan in', icon: 'scan' },
  { to: '/tag', label: 'My tag', icon: 'tag' },
  { to: '/dues', label: 'Dues', icon: 'card' },
  { to: '/profile', label: 'Profile', icon: 'user' },
];

export const excoTabs: { to: string; label: string; icon: IconName }[] = [
  { to: '/exco', label: 'Today', icon: 'grid' },
  { to: '/exco/door', label: 'Door', icon: 'door' },
  { to: '/exco/call', label: 'Call', icon: 'megaphone' },
  { to: '/exco/table', label: 'Table', icon: 'finger' },
  { to: '/exco/members', label: 'Members', icon: 'users' },
];

export function BottomNav({ mode }: { mode: 'member' | 'exco' }) {
  const tabs = mode === 'exco' ? excoTabs : memberTabs;
  return (
    <nav className="no-print fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md lg:hidden px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="flex justify-around rounded-3xl border border-line bg-card/95 p-1.5 shadow-lift backdrop-blur">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/exco'}
            className={({ isActive }) =>
              `relative flex min-h-[52px] min-w-[58px] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-bold ${
                isActive ? 'text-white' : 'text-muted'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId={`nav-${mode}`}
                    className="absolute inset-0 rounded-2xl bg-green"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative">
                  <Icon name={t.icon} size={21} />
                </span>
                <span className="relative">{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
