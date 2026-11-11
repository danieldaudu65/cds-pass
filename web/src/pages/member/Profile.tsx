import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { PhotoPicker } from '../../components/PhotoPicker';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Button, ErrorBox, Field, Icon, Page, Pill, TopBar } from '../../components/ui';
import { useAuth, useMe } from '../../hooks/useAuth';
import { useGroup } from '../../hooks/useLive';
import { db, errorText } from '../../lib/firebase';
import { enableNotifications, pushState, type PushState } from '../../lib/messaging';
import { normalizePhone } from '../../lib/rules';
import { toast } from '../../lib/toast';
import { uploadAvatar } from '../../lib/upload';

export default function Profile() {
  const me = useMe();
  const { logout } = useAuth();
  const group = useGroup(me.groupId);
  const [push, setPush] = useState<PushState>('default');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [phone, setPhone] = useState(me.phone);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void pushState(me.uid).then(setPush);
  }, [me.uid]);

  async function turnOnPush() {
    setError('');
    setBusy('push');
    try {
      await enableNotifications(me.uid);
      setPush('enabled');
      toast('Notifications on', 'success', "We'll buzz you when your batch is called.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function save() {
    setError('');
    const p = normalizePhone(phone);
    if (!p) return setError('Enter a valid Nigerian phone number.');
    setBusy('save');
    try {
      const patch: Record<string, unknown> = { phone: p, updatedAt: serverTimestamp() };
      if (photo) patch.photoURL = await uploadAvatar(me.uid, photo);
      await updateDoc(doc(db, 'users', me.uid), patch);
      setPhoto(null);
      toast('Profile saved', 'success');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <TopBar title="Profile" sub={group?.name} />
      <Page className="space-y-4">
        <div className="card">
          <PhotoPicker value={photo} currentPhotoURL={me.photoURL} onChange={(b, err) => (setPhoto(b), setError(err ?? ''))} />
          {!photo && me.photoURL && (
            <p className="mt-3 text-center text-xs text-muted">Your current photo is shown on your tag. Pick a new one to replace it.</p>
          )}
        </div>

        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-extrabold">{me.fullName}</p>
              <p className="text-sm font-semibold text-muted">{me.stateCode}</p>
            </div>
            <Pill>{me.role === 'exco' ? 'Exco' : 'Member'}</Pill>
          </div>
          <Field label="Phone number" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <p className="text-xs text-muted">To change your name or state code, ask an exco. They must match your NYSC ID card.</p>
          <Button loading={busy === 'save'} onClick={save}>
            Save changes
          </Button>
        </div>

        <div className="card space-y-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-green-light text-green">
              <Icon name="bell" />
            </span>
            <div className="flex-1">
              <p className="font-bold">Batch alerts</p>
              <p className="text-sm text-muted">
                {push === 'enabled'
                  ? 'Enabled on this device. Your phone can buzz when your batch is called.'
                  : push === 'granted'
                    ? 'Browser permission is allowed. Connect this device to turn on batch alerts.'
                  : push === 'denied'
                    ? 'Blocked. Allow notifications in your browser settings.'
                    : push === 'unsupported'
                      ? 'Not available on this browser. Keep CDS Pass open on CDS day.'
                      : 'Get a buzz when it is your turn to thumbprint.'}
              </p>
            </div>
          </div>
          {push !== 'enabled' && push !== 'denied' && push !== 'unsupported' && (
            <Button variant="ghost" loading={busy === 'push'} onClick={turnOnPush}>
              Turn on alerts
            </Button>
          )}
        </div>

        <div className="card">
          <ThemeToggle />
        </div>

        <ErrorBox>{error}</ErrorBox>

        <Button variant="outline" onClick={logout}>
          <Icon name="logout" /> Log out
        </Button>
        <p className="text-center text-xs text-muted">CDS Pass is an independent tool for CDS groups. Not affiliated with NYSC.</p>
      </Page>
    </>
  );
}
