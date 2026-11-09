import { useState } from 'react';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Button, ErrorBox, Field, Page, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useLogs } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { getPosition } from '../../lib/device';
import { errorText } from '../../lib/firebase';
import { toast } from '../../lib/toast';

const actionText: Record<string, string> = {
  group_created: 'Created the group',
  member_registered: 'Signed up',
  member_approved: 'Approved a member',
  member_rejected: 'Rejected a member',
  role_changed: 'Changed a role',
  pin_reset: 'Reset a PIN',
  settings_changed: 'Changed settings',
  session_opened: 'Opened the meeting',
  session_closed: 'Closed the meeting',
  manual_checkin: 'Manual check-in',
  priority_given: 'Gave a priority tag',
  batch_called: 'Called a batch',
  table_refused: 'Refused at table',
  thumbprinted: 'Marked thumbprinted',
  payout_account_set: 'Set dues account',
  dues_created: 'Created dues',
  dues_closed: 'Closed dues',
  cash_recorded: 'Recorded cash',
  cash_confirmed: 'Member confirmed cash',
  cash_disputed: 'Member disputed cash',
  dues_reminder: 'Sent dues reminder',
};

export default function Settings() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const logs = useLogs(me.groupId, 40);
  const [size, setSize] = useState('');
  const [radius, setRadius] = useState('300');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    setError('');
    setBusy(label);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function setVenueHere() {
    setBusy('venue');
    const pos = await getPosition(12000);
    setBusy('');
    if (!pos) return setError('Could not get your location. Turn on location and try again.');
    await run('venue', () => api.updateGroupSettings({ venue: { ...pos, radiusM: Number(radius) || 300 } }), 'Venue saved. Members must be within range to scan in.');
  }

  return (
    <>
      <TopBar title="Group settings" back="/exco" sub={group?.name} />
      <Page className="space-y-4">
        <div className="card space-y-2 text-center">
          <p className="text-sm font-semibold text-muted">Group code for new members</p>
          <p className="text-4xl font-extrabold tracking-[0.3em] text-green">{group?.joinCode ?? '……'}</p>
          <Button
            variant="ghost"
            onClick={() => {
              const text = `Join our CDS group on CDS Pass: open ${location.origin} and use group code ${group?.joinCode}`;
              if (navigator.share) void navigator.share({ text }).catch(() => undefined);
              else void navigator.clipboard?.writeText(text).then(() => toast('Copied', 'success'));
            }}
          >
            Share with members
          </Button>
        </div>

        <div className="card space-y-3">
          <Field
            label={`Batch size (now ${group?.batchSize ?? 20})`}
            inputMode="numeric"
            placeholder="20"
            value={size}
            onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))}
          />
          <Button loading={busy === 'size'} disabled={!size} onClick={() => run('size', () => api.updateGroupSettings({ batchSize: Number(size) }), 'Batch size saved')}>
            Save batch size
          </Button>
        </div>

        <div className="card space-y-3">
          <p className="font-bold">Venue location check</p>
          <p className="text-sm text-muted">
            {group?.venue
              ? `On: members must be within ${group.venue.radiusM} m of the venue to scan in.`
              : 'Off. Stand at the CDS venue and tap the button to turn it on.'}
          </p>
          <Field label="Allowed distance (metres)" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ''))} />
          <Button loading={busy === 'venue'} onClick={setVenueHere}>
            Use my current location as the venue
          </Button>
          {group?.venue && (
            <Button variant="outline" loading={busy === 'clear'} onClick={() => run('clear', () => api.updateGroupSettings({ clearVenue: true }), 'Location check turned off')}>
              Turn off location check
            </Button>
          )}
        </div>

        <div className="card">
          <ThemeToggle />
        </div>

        <ErrorBox>{error}</ErrorBox>

        <div className="card !p-0">
          <p className="px-5 pb-2 pt-4 font-bold">Activity log</p>
          <p className="px-5 pb-3 text-xs text-muted">Every exco action is recorded here. Nobody can edit or delete it.</p>
          <ul className="divide-y divide-line">
            {(logs ?? []).map((l) => (
              <li key={l.id} className="px-5 py-3 text-sm">
                <p className="font-semibold">
                  {actionText[l.action] ?? l.action}
                  {typeof l.label === 'string' ? ` · ${l.label}` : ''}
                  {l.stateCode ? ` · ${l.stateCode}` : ''}
                  {typeof l.reason === 'string' ? ` · ${String(l.reason).replace(/_/g, ' ')}` : ''}
                </p>
                <p className="text-xs text-muted">{l.at?.toDate().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</p>
              </li>
            ))}
          </ul>
        </div>
      </Page>
    </>
  );
}
