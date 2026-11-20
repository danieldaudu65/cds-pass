import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Button, Checkbox, ErrorBox, Field, Icon, Page, Pill, Select, Stat } from '../../components/ui';
import { usePlatformRole } from '../../hooks/usePlatform';
import { api, type AdminConfig, type AdminGroupRow, type AdminOverview } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { naira } from '../../lib/money';
import { toast } from '../../lib/toast';
import { TrendChart } from './Charts';

type Tab = 'overview' | 'groups' | 'controls' | 'message' | 'team';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const nairaShort = (kobo: number) => {
  const n = kobo / 100;
  return n >= 1_000_000 ? `₦${(n / 1_000_000).toFixed(1)}m` : n >= 1000 ? `₦${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `₦${Math.round(n)}`;
};

/* ---------------------------------------------------------------- overview */

function Overview({ data }: { data: AdminOverview }) {
  const s = data.series;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat tone="light" value={data.totals.groups} label={`CDS groups · ${data.totals.activeGroups} met this month`} />
        <Stat tone="light" value={data.totals.members.toLocaleString()} label={`Members · ${data.totals.pending} waiting`} />
        <Stat tone="light" value={data.totals.checkins30.toLocaleString()} label="Check-ins (30 days)" />
        <Stat tone="gold" value={naira(data.totals.earnedKobo)} label="Your earnings (all time)" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <TrendChart title="New sign-ups per day" days={s.days} values={s.signups} kind="line" total={`${sum(s.signups)} in 30 days`} />
        <TrendChart title="Check-ins per CDS day" days={s.days} values={s.checkins} kind="bar" total={`${sum(s.checkins)} in 30 days`} />
        <TrendChart
          title="Dues collected per day"
          days={s.days}
          values={s.paidKobo}
          kind="bar"
          format={nairaShort}
          total={naira(sum(s.paidKobo))}
        />
        <TrendChart
          title="Your earnings per day (3% fee)"
          days={s.days}
          values={s.earnedKobo}
          kind="line"
          format={nairaShort}
          total={naira(sum(s.earnedKobo))}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat tone="light" value={naira(data.totals.onlineKobo)} label="Dues paid online (all time)" />
        <Stat tone="light" value={naira(data.totals.cashKobo)} label="Cash recorded (all time)" />
      </div>
      <p className="text-center text-xs text-muted">
        Updated {new Date(data.generatedAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}. Figures refresh every 5 minutes.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- groups */

function Groups({ data, canEdit, onChanged }: { data: AdminOverview; canEdit: boolean; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.groups.filter((g) => !t || `${g.name} ${g.lga} ${g.state} ${g.joinCode}`.toLowerCase().includes(t));
  }, [data.groups, q]);

  async function pause(g: AdminGroupRow) {
    const next = !g.paused;
    if (!confirm(next ? `Pause ${g.name}? Members can't check in or pay until you resume it.` : `Resume ${g.name}?`)) return;
    setBusy(g.id);
    try {
      await api.adminSetGroupPaused({ gid: g.id, paused: next });
      toast(next ? `${g.name} paused` : `${g.name} resumed`, 'success');
      onChanged();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-3">
      <input className="input" placeholder="Search group, LGA, state or code" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search groups" />
      {list.length === 0 && <p className="card text-center text-sm text-muted">No groups match.</p>}
      {list.map((g) => (
        <div key={g.id} className="card !p-0">
          <button onClick={() => setOpen(open === g.id ? null : g.id)} className="flex w-full items-center gap-3 p-4 text-left">
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl font-display font-extrabold ${g.paused ? 'bg-bad-bg text-bad' : 'bg-green-light text-green'}`}>
              {g.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold">{g.name}</span>
              <span className="block truncate text-xs text-muted">
                {g.lga}, {g.state} · {g.members} members{g.pending ? ` · ${g.pending} waiting` : ''}
              </span>
            </span>
            {g.paused ? <Pill tone="bad">Paused</Pill> : g.lastMeeting ? <Pill>Active</Pill> : <Pill tone="muted">No meeting</Pill>}
          </button>
          <AnimatePresence>
            {open === g.id && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="space-y-3 border-t border-line p-4">
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                    <Info k="Group code" v={g.joinCode} />
                    <Info k="Main exco" v={g.mainExcoStateCode ?? '—'} />
                    <Info k="Excos" v={String(g.excos)} />
                    <Info k="Last meeting" v={g.lastMeeting ? `${g.lastMeeting} · ${g.lastCheckins} in` : '—'} />
                    <Info k="Missing photos" v={String(g.noPhoto)} />
                    <Info k="Paid online" v={naira(g.onlineKobo)} />
                    <Info k="Cash recorded" v={naira(g.cashKobo)} />
                    <Info k="Your earnings" v={naira(g.earnedKobo)} />
                  </div>
                  {canEdit && (
                    <Button variant={g.paused ? 'primary' : 'outline'} loading={busy === g.id} onClick={() => pause(g)}>
                      {g.paused ? 'Resume this group' : 'Pause this group'}
                    </Button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl bg-paper px-3 py-2">
      <p className="text-[11px] font-semibold text-muted">{k}</p>
      <p className="truncate font-bold">{v}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- controls */

function Controls({ config, canEdit, onSaved }: { config: AdminConfig; canEdit: boolean; onSaved: () => void }) {
  const [banner, setBanner] = useState(config.banner ?? '');
  const [maintenance, setMaintenance] = useState(config.maintenance ?? '');
  const [busy, setBusy] = useState('');

  async function save(key: string, patch: Parameters<typeof api.adminSetConfig>[0], done: string) {
    setBusy(key);
    try {
      await api.adminSetConfig(patch);
      toast(done, 'success');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      {!canEdit && <p className="rounded-2xl bg-gold-bg px-4 py-3 text-sm text-gold-text">You have view-only access.</p>}
      <div className="card space-y-3">
        <p className="font-bold">Switches</p>
        <Checkbox
          checked={config.signupsPaused}
          onChange={(v) => canEdit && save('signups', { signupsPaused: v }, v ? 'New sign-ups paused' : 'Sign-ups open again')}
          className="rounded-2xl bg-paper p-3 text-sm"
        >
          <span className="font-bold">Pause new sign-ups</span>
          <span className="block text-xs text-muted">Existing members keep working.</span>
        </Checkbox>
        <Checkbox
          checked={config.paymentsPaused}
          onChange={(v) => canEdit && save('payments', { paymentsPaused: v }, v ? 'Online payments paused' : 'Online payments back on')}
          className="rounded-2xl bg-paper p-3 text-sm"
        >
          <span className="font-bold">Pause online payments</span>
          <span className="block text-xs text-muted">Members can still pay cash to excos.</span>
        </Checkbox>
      </div>

      <div className="card space-y-3">
        <p className="font-bold">Announcement banner</p>
        <p className="text-sm text-muted">A gold bar at the top of everyone's app. Leave empty to remove it.</p>
        <Field label="Banner text" maxLength={200} placeholder="New: pay your dues online in CDS Pass" value={banner} onChange={(e) => setBanner(e.target.value)} />
        <Button variant="gold" disabled={!canEdit} loading={busy === 'banner'} onClick={() => save('banner', { banner: banner.trim() || null }, banner.trim() ? 'Banner is live' : 'Banner removed')}>
          {banner.trim() ? 'Show banner' : 'Remove banner'}
        </Button>
      </div>

      <div className="card space-y-3">
        <p className="font-bold">Maintenance mode</p>
        <p className="text-sm text-muted">Everyone except the admin team sees an “updating” screen. Use while you upload a big update.</p>
        <Field label="Message" maxLength={200} placeholder="CDS Pass is updating. Back in 10 minutes." value={maintenance} onChange={(e) => setMaintenance(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={!canEdit || !maintenance.trim()}
            loading={busy === 'mOn'}
            onClick={() => confirm('Turn maintenance ON for everyone?') && save('mOn', { maintenance: maintenance.trim() }, 'Maintenance is ON')}
          >
            Turn on
          </Button>
          <Button disabled={!canEdit || !config.maintenance} loading={busy === 'mOff'} onClick={() => save('mOff', { maintenance: null }, 'Maintenance is OFF')}>
            Turn off
          </Button>
        </div>
        {config.maintenance && <Pill tone="bad">Maintenance is ON now</Pill>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- broadcast */

function Broadcast({ data, canEdit }: { data: AdminOverview; canEdit: boolean }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'everyone' | 'excos'>('everyone');
  const [target, setTarget] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    setError('');
    const where = target === 'all' ? 'ALL CDS groups' : data.groups.find((g) => g.id === target)?.name;
    if (!confirm(`Send "${title}" to ${audience === 'excos' ? 'excos' : 'everyone'} in ${where}?`)) return;
    setBusy(true);
    try {
      const r = await api.adminBroadcast({ title, body, audience, gids: target === 'all' ? [] : [target], link: '/home' });
      toast(`Sent to ${r.recipients} people`, 'success');
      setTitle('');
      setBody('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <Select
        label="Which CDS groups"
        value={target}
        onChange={setTarget}
        options={[{ value: 'all', label: 'All CDS groups' }, ...data.groups.map((g) => ({ value: g.id, label: g.name, hint: `${g.lga} · ${g.members} members` }))]}
      />
      <Select<'everyone' | 'excos'>
        label="Who"
        value={audience}
        onChange={setAudience}
        options={[
          { value: 'everyone', label: 'Everyone (approved members)' },
          { value: 'excos', label: 'Excos only' },
        ]}
      />
      <Field label="Title" maxLength={60} placeholder="New on CDS Pass" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div>
        <label htmlFor="b-body" className="label">
          Message
        </label>
        <textarea id="b-body" rows={4} maxLength={300} className="input !h-auto resize-none py-3" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <ErrorBox>{error}</ErrorBox>
      <Button disabled={!canEdit || title.trim().length < 3 || body.trim().length < 3} loading={busy} onClick={send}>
        <Icon name="bell" /> Send to {target === 'all' ? 'all groups' : 'this group'}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- team */

function Team({ config, onSaved }: { config: AdminConfig; onSaved: () => void }) {
  const [sc, setSc] = useState('');
  const [role, setRole] = useState<'viewer' | 'admin'>('viewer');
  const [busy, setBusy] = useState('');

  async function set(stateCode: string, r: 'viewer' | 'admin' | null) {
    setBusy(stateCode);
    try {
      await api.adminSetTeamMember({ stateCode, role: r });
      toast(r ? 'Team updated' : 'Removed from the team', 'success');
      setSc('');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <p className="font-bold">Admin team</p>
        <p className="text-sm text-muted">
          <b>Viewer</b>: sees charts and all groups. <b>Admin</b>: can also use switches, pause groups, send messages and create groups. Only you
          (owner {config.owner}) can change the team.
        </p>
        <ul className="divide-y divide-line">
          <li className="flex items-center justify-between py-2 text-sm">
            <span className="font-bold">{config.owner}</span>
            <Pill tone="gold">Owner</Pill>
          </li>
          {config.team.map((m) => (
            <li key={m.stateCode} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="font-bold">{m.stateCode}</span>
              <span className="flex items-center gap-2">
                <Pill tone={m.role === 'admin' ? 'green' : 'muted'}>{m.role === 'admin' ? 'Admin' : 'Viewer'}</Pill>
                <button
                  disabled={busy === m.stateCode}
                  onClick={() => confirm(`Remove ${m.stateCode} from the team?`) && set(m.stateCode, null)}
                  className="text-xs font-bold text-bad"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card space-y-3">
        <p className="font-bold">Add someone</p>
        <Field label="Their state code" placeholder="LA/26B/1234" autoCapitalize="characters" value={sc} onChange={(e) => setSc(e.target.value)} />
        <Select<'viewer' | 'admin'>
          label="Access"
          value={role}
          onChange={setRole}
          options={[
            { value: 'viewer', label: 'Viewer (see only)', hint: 'Best for a partner' },
            { value: 'admin', label: 'Admin (can change things)' },
          ]}
        />
        <Button loading={busy === sc && !!sc} disabled={sc.trim().length < 8} onClick={() => set(sc.trim(), role)}>
          Add to team
        </Button>
        <p className="text-xs text-muted">They need a CDS Pass account. After you add them, they log out and in again to see Admin mode.</p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- page */

export default function Admin() {
  const role = usePlatformRole();
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const [o, c] = await Promise.all([api.adminOverview({ refresh }), api.adminGetConfig({})]);
      setData(o);
      setConfig(c);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (role === null && error) return <Navigate to="/home" replace />;
  const canEdit = config?.role === 'owner' || config?.role === 'admin';
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'groups', label: 'Groups' },
    { id: 'controls', label: 'Controls' },
    { id: 'message', label: 'Message' },
    ...(config?.role === 'owner' ? [{ id: 'team' as Tab, label: 'Team' }] : []),
  ];

  return (
    <div className="min-h-[100dvh] bg-paper text-ink">
      <header className="hero-green px-5 pb-6 pt-[max(env(safe-area-inset-top),20px)] text-white">
        <div className="mx-auto max-w-5xl">
          <p className="text-sm text-green-mid">🛡️ Admin mode{config ? ` · ${config.role}` : ''}</p>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-extrabold">CDS Pass control room</h1>
            <button
              onClick={() => load(true)}
              disabled={loading}
              className="mr-24 h-9 shrink-0 rounded-full bg-white/15 px-3 text-xs font-bold disabled:opacity-50 lg:mr-28"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          <div className="mt-4 flex gap-1 overflow-x-auto rounded-2xl bg-white/10 p-1">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`relative h-10 shrink-0 flex-1 rounded-xl px-3 text-sm font-bold ${tab === t.id ? 'text-brand' : 'text-white'}`}>
                {tab === t.id && <motion.span layoutId="admin-tab" className="absolute inset-0 rounded-xl bg-white" />}
                <span className="relative">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>
      <Page className="mx-auto max-w-5xl space-y-4 pb-16">
        <ErrorBox>{error}</ErrorBox>
        {!data || !config ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="card h-48 animate-pulse" />
            ))}
          </div>
        ) : tab === 'overview' ? (
          <Overview data={data} />
        ) : tab === 'groups' ? (
          <Groups data={data} canEdit={canEdit} onChanged={() => load(true)} />
        ) : tab === 'controls' ? (
          <Controls key={JSON.stringify(config)} config={config} canEdit={canEdit} onSaved={() => load()} />
        ) : tab === 'message' ? (
          <Broadcast data={data} canEdit={canEdit} />
        ) : (
          <Team config={config} onSaved={() => load()} />
        )}
      </Page>
    </div>
  );
}
