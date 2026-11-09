import { motion } from 'framer-motion';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Avatar } from './Avatar';
import { excoTabs, memberTabs } from './BottomNav';
import { Icon } from './ui';

/** Laptop / desktop navigation (the bottom bar is used on phones). */
export function SideNav({ mode }: { mode: 'member' | 'exco' }) {
  const { profile, logout } = useAuth();
  const tabs = mode === 'exco' ? [...excoTabs, { to: '/exco/dues', label: 'Dues', icon: 'card' }, { to: '/exco/settings', label: 'Settings', icon: 'settings' }] : memberTabs;

  return (
    <aside className="no-print sticky top-0 hidden h-[100dvh] w-[280px] shrink-0 flex-col border-r border-line bg-card px-5 py-6 lg:flex">
      <Link to={mode === 'exco' ? '/exco' : '/home'} className="flex items-center gap-3 px-2">
        <img src="/icon.svg" alt="" className="h-10 w-10 rounded-2xl" />
        <div>
          <p className="font-extrabold leading-tight">CDS Pass</p>
          <p className="text-xs font-semibold text-muted">{mode === 'exco' ? 'Exco tools' : 'Corps member'}</p>
        </div>
      </Link>

      <nav className="mt-8 flex flex-col gap-1">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/exco'}
            className={({ isActive }) =>
              `relative flex h-12 items-center gap-3 rounded-2xl px-4 text-sm font-bold transition-colors ${
                isActive ? 'text-white' : 'text-muted hover:bg-green-light hover:text-green'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId={`side-${mode}`}
                    className="absolute inset-0 rounded-2xl bg-green shadow-card"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative">
                  <Icon name={t.icon} size={20} />
                </span>
                <span className="relative">{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {profile?.role === 'exco' && (
        <Link
          to={mode === 'exco' ? '/home' : '/exco'}
          className="mt-6 flex h-12 items-center justify-center gap-2 rounded-2xl border-2 border-line text-sm font-bold text-green"
        >
          <Icon name={mode === 'exco' ? 'tag' : 'grid'} size={18} />
          {mode === 'exco' ? 'My own tag' : 'Exco mode'}
        </Link>
      )}

      <div className="mt-auto flex items-center gap-3 rounded-2xl bg-paper p-3">
        {profile && <Avatar src={profile.photoURL} name={profile.fullName} size={40} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{profile?.fullName}</p>
          <p className="truncate text-xs text-muted">{profile?.stateCode}</p>
        </div>
        <button onClick={logout} aria-label="Log out" className="grid h-10 w-10 place-items-center rounded-xl text-muted hover:bg-line">
          <Icon name="logout" size={18} />
        </button>
      </div>
    </aside>
  );
}
