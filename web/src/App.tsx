import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { BottomNav } from './components/BottomNav';
import { InstallGate } from './components/InstallGate';
import { SideNav } from './components/SideNav';
import { Toaster } from './components/Toaster';
import { Spinner } from './components/ui';
import { useAuth } from './hooks/useAuth';
import { startOfflineSync } from './lib/offlineQueue';
import { useSignupLock } from './lib/signupLock';
import Login from './pages/Login';
import Pending from './pages/Pending';
import Signup from './pages/Signup';
import Welcome from './pages/Welcome';
import Home from './pages/member/Home';
import MyTag from './pages/member/MyTag';
import Profile from './pages/member/Profile';
import ScanIn from './pages/member/ScanIn';
import Dues from './pages/member/Dues';
import DuesAdmin from './pages/exco/DuesAdmin';
import CallBatch from './pages/exco/CallBatch';
import Dashboard from './pages/exco/Dashboard';
import Door from './pages/exco/Door';
import Members from './pages/exco/Members';
import PrintCards from './pages/exco/PrintCards';
import Settings from './pages/exco/Settings';
import Table from './pages/exco/Table';

function Splash() {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-green-dark">
      <div className="flex flex-col items-center gap-4 text-white">
        <img src="/icon.svg" alt="" className="h-20 w-20 rounded-3xl shadow-lift" />
        <Spinner light />
      </div>
    </div>
  );
}

function ProfileReadError({ message, onLogout }: { message: string; onLogout: () => void }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-paper px-6 text-ink">
      <div className="w-full max-w-md space-y-4 rounded-3xl bg-card p-6 shadow-card">
        <h1 className="text-xl font-extrabold">Couldn’t load your CDS profile</h1>
        <p className="text-sm text-muted">
          Your login worked, but CDS Pass could not check your saved registration. This can happen if the connection
          failed or this website is connected to a different Firebase project. Your account has not been deleted.
        </p>
        <p className="break-words rounded-xl bg-line p-3 text-xs text-muted">{message}</p>
        <button onClick={() => window.location.reload()} className="h-12 w-full rounded-2xl bg-green font-bold text-white">
          Try again
        </button>
        <button onClick={onLogout} className="w-full py-2 text-sm font-bold text-muted">
          Log out
        </button>
      </div>
    </div>
  );
}

/** Phone: one column + bottom bar. Laptop: sidebar + wider content. */
function AppShell({ mode }: { mode: 'member' | 'exco' }) {
  return (
    <div className="min-h-[100dvh] bg-paper lg:flex">
      <SideNav mode={mode} />
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col lg:max-w-4xl lg:px-10 lg:pt-4">
        <Outlet />
      </div>
      <BottomNav mode={mode} />
    </div>
  );
}

function MemberLayout() {
  return <AppShell mode="member" />;
}

function ExcoLayout() {
  const { profile } = useAuth();
  if (profile?.role !== 'exco') return <Navigate to="/home" replace />;
  return <AppShell mode="exco" />;
}

export default function App() {
  const { user, profile, profileError, ready, logout } = useAuth();
  const lock = useSignupLock();

  useEffect(() => {
    if (ready) startOfflineSync();
  }, [ready]);

  if (user && profileError) {
    return (
      <InstallGate>
        <ProfileReadError message={profileError} onLogout={() => void logout()} />
      </InstallGate>
    );
  }

  let routes: JSX.Element;
  if (user === undefined || (!lock && user && profile === undefined)) {
    return (
      <InstallGate>
        <Splash />
      </InstallGate>
    );
  } else if (!user || lock === 'signup') {
    routes = (
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  } else if (profile === null || lock === 'finish') {
    // Account created but registration not finished (e.g. data cut off mid-signup).
    routes = (
      <Routes>
        <Route path="/signup" element={<Signup finish />} />
        <Route path="*" element={<Navigate to="/signup" replace />} />
      </Routes>
    );
  } else if (profile && profile.status !== 'approved') {
    routes = (
      <Routes>
        <Route path="/pending" element={<Pending />} />
        <Route path="*" element={<Navigate to="/pending" replace />} />
      </Routes>
    );
  } else if (!ready) {
    return <Splash />;
  } else {
    const homePath = profile?.role === 'exco' ? '/exco' : '/home';
    routes = (
      <Routes>
        <Route element={<MemberLayout />}>
          <Route path="/home" element={<Home />} />
          <Route path="/scan" element={<ScanIn />} />
          <Route path="/tag" element={<MyTag />} />
          <Route path="/dues" element={<Dues />} />
          <Route path="/profile" element={<Profile />} />
        </Route>
        <Route path="/exco" element={<ExcoLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="door" element={<Door />} />
          <Route path="call" element={<CallBatch />} />
          <Route path="table" element={<Table />} />
          <Route path="members" element={<Members />} />
          <Route path="dues" element={<DuesAdmin />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="/exco/cards" element={profile?.role === 'exco' ? <PrintCards /> : <Navigate to="/home" replace />} />
        <Route path="*" element={<Navigate to={homePath} replace />} />
      </Routes>
    );
  }

  return (
    <InstallGate>
      <Toaster />
      {routes}
    </InstallGate>
  );
}
