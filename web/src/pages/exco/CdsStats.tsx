import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { Stat } from '../../components/ui';
import { api, type GroupStats } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { naira } from '../../lib/money';
import { BarList, TrendChart } from '../admin/Charts';

const HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const nairaShort = (kobo: number) => {
  const n = kobo / 100;
  return n >= 1_000_000 ? `₦${(n / 1_000_000).toFixed(1)}m` : n >= 1000 ? `₦${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `₦${Math.round(n)}`;
};
const shortDate = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });

// Kept for the session so going back and forth to the dashboard doesn't reload it.
let cached: GroupStats | null = null;

/** Exco dashboard: Admin-style charts for this CDS only. */
export function CdsStats() {
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<GroupStats | null>(cached);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const r = await api.groupStats({ refresh });
      cached = r;
      setData(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !cached) void load();
  }, [open, load]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-left">
          <h2 className="text-lg font-extrabold">CDS stats</h2>
          <motion.span animate={{ rotate: open ? 180 : 0 }} className="text-green">
            ▾
          </motion.span>
        </button>
        {open && (
          <button onClick={() => load(true)} disabled={loading} className="text-sm font-bold text-green disabled:opacity-50">
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-3 overflow-hidden">
            {error && <p className="rounded-2xl bg-bad-bg px-4 py-3 text-sm text-bad">{error}</p>}
            {!data ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {[0, 1].map((i) => (
                  <div key={i} className="card h-44 animate-pulse" />
                ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat tone="light" value={data.totals.members} label={`Members · ${data.totals.pending} waiting`} />
                  <Stat tone="gold" value={`${data.totals.alertsOn}/${data.totals.members}`} label="Alerts turned on" />
                  <Stat tone="light" value={naira(data.totals.onlineKobo)} label="Dues paid online" />
                  <Stat tone="light" value={naira(data.totals.cashKobo)} label="Cash recorded" />
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <TrendChart
                    title="Checked in per meeting"
                    days={data.meetings.map((m) => m.date)}
                    values={data.meetings.map((m) => m.checkedIn)}
                    kind="bar"
                    label={shortDate}
                    total={data.meetings.length ? `${data.meetings[data.meetings.length - 1].checkedIn} last time` : undefined}
                    note={data.meetings.length ? undefined : 'No meetings yet.'}
                  />
                  <BarList
                    title="Thumbprinted vs checked in"
                    rows={data.meetings
                      .slice(-4)
                      .reverse()
                      .map((m) => ({ label: shortDate(m.date), value: m.done, max: m.checkedIn }))}
                  />
                  <TrendChart
                    title="When people arrived (last meeting)"
                    days={HOURS.map(String)}
                    values={HOURS.map((h) => data.arrivalHours[h] ?? 0)}
                    kind="bar"
                    label={(h) => `${Number(h) % 12 || 12}${Number(h) < 12 ? 'am' : 'pm'}`}
                  />
                  <TrendChart
                    title="Dues collected per day"
                    days={data.days}
                    values={data.paidKobo}
                    kind="bar"
                    format={nairaShort}
                    total={naira(sum(data.paidKobo))}
                  />
                  <TrendChart title="New members per day" days={data.days} values={data.joins} kind="line" total={`${sum(data.joins)} in 30 days`} />
                  <BarList
                    title="Open dues: who has paid"
                    rows={data.openDues.map((d) => ({
                      label: d.title,
                      value: d.paid,
                      max: d.members,
                      hint: d.dueDate ? `Collection ${shortDate(d.dueDate)}` : undefined,
                    }))}
                  />
                  <BarList
                    title="Members by batch"
                    rows={Object.entries(data.batchSplit)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([b, n]) => ({ label: `Batch ${b}`, value: Number(n) }))}
                  />
                </div>
                <p className="text-center text-xs text-muted">
                  {data.totals.noPhoto ? `${data.totals.noPhoto} members have no photo yet · ` : ''}Updated{' '}
                  {new Date(data.generatedAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}
                </p>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
