import { useState } from 'react';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Button, ErrorBox, Field, Page, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useLogs } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { getPosition } from '../../lib/device';
import { errorText } from '../../lib/firebase';
import { toast } from '../../lib/toast';
import { normalizeStateCode } from '../../lib/rules';
import { PLATFORM_ADMIN_STATE_CODE } from '../../lib/appConfig';

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
  notification_test: 'Tested push notifications',
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
  const [newGroup, setNewGroup] = useState({ name: '', lga: '', state: '', mainExcoStateCode: '' });
  const [createdGroup, setCreatedGroup] = useState<{ joinCode: string; mainExcoStateCode: string } | null>(null);

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

  async function testNotification() {
    setError('');
    setBusy('notification');
    try {
      const result = await api.testNotification({});
      if (!result.registered) {
        setError(`No approved members have alerts registered yet (${result.members} members in the group). Members need to turn on alerts in their Profile.`);
      } else if (!result.sent) {
        setError(`Firebase delivered 0 of ${result.registered} registered member devices. Members should re-enable alerts; check the server logs if this continues.`);
      } else {
        toast('Test notification sent', 'success', `${result.sent} devices notified across ${result.members} approved members.`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function createGroup() {
    setError('');
    const mainExcoStateCode = normalizeStateCode(newGroup.mainExcoStateCode);
    if (!mainExcoStateCode) return setError('Enter a valid state code for the new group’s main exco.');
    setBusy('create-group');
    try {
      const result = await api.createManagedGroup({
        group: { name: newGroup.name, lga: newGroup.lga, state: newGroup.state },
        mainExcoStateCode,
      });
      setCreatedGroup({ joinCode: result.joinCode, mainExcoStateCode: result.mainExcoStateCode });
      setNewGroup({ name: '', lga: '', state: '', mainExcoStateCode: '' });
      toast('CDS group created', 'success', `Share code ${result.joinCode} with the appointed main exco.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
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

        <div className="card space-y-3">
          <p className="font-bold">Test notifications</p>
          <p className="text-sm text-muted">The main exco can send a test alert to every approved CDS member who has enabled notifications.</p>
          {(group?.mainExcoUid ?? group?.createdBy) === me.uid ? (
            <Button variant="ghost" loading={busy === 'notification'} onClick={testNotification}>
              Send test notification to all members
            </Button>
          ) : (
            <p className="text-sm font-semibold text-muted">Only the main exco can send the group test notification.</p>
          )}
        </div>

        {me.stateCode === PLATFORM_ADMIN_STATE_CODE && (
          <div className="card space-y-3">
            <p className="font-bold">Create another CDS group</p>
            <p className="text-sm text-muted">Choose the member who will own this group as its main exco. Your current group membership will stay as it is.</p>
            <Field label="New CDS group name" placeholder="Digital Skills CDS" value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
            <Field label="LGA" placeholder="Ikorodu" value={newGroup.lga} onChange={(e) => setNewGroup({ ...newGroup, lga: e.target.value })} />
            <Field label="State" placeholder="Lagos" value={newGroup.state} onChange={(e) => setNewGroup({ ...newGroup, state: e.target.value })} />
            <Field
              label="Main exco state code"
              placeholder="LA/26B/1142"
              autoCapitalize="characters"
              value={newGroup.mainExcoStateCode}
              onChange={(e) => setNewGroup({ ...newGroup, mainExcoStateCode: e.target.value })}
            />
            <Button loading={busy === 'create-group'} onClick={createGroup}>Create CDS group</Button>
            {createdGroup && (
              <div className="rounded-2xl bg-green-light p-4 text-center">
                <p className="text-sm font-semibold text-muted">Give this group code to {createdGroup.mainExcoStateCode}</p>
                <p className="my-2 text-3xl font-extrabold tracking-[0.3em] text-green">{createdGroup.joinCode}</p>
                <p className="text-xs text-muted">They join with this code and their state code. CDS Pass will make them the approved main exco automatically.</p>
                <Button
                  className="mt-3"
                  variant="ghost"
                  onClick={() => {
                    const text = `You are the main exco for a CDS Pass group. Open ${location.origin}, sign up with state code ${createdGroup.mainExcoStateCode}, and join using group code ${createdGroup.joinCode}.`;
                    if (navigator.share) void navigator.share({ text }).catch(() => undefined);
                    else void navigator.clipboard?.writeText(text).then(() => toast('Instructions copied', 'success'));
                  }}
                >
                  Share setup instructions
                </Button>
              </div>
            )}
          </div>
        )}

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
                <p className="text-xs text-muted">{l.atMs ? new Date(l.atMs).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable'}</p>
              </li>
            ))}
          </ul>
        </div>
      </Page>
    </>
  );
}
