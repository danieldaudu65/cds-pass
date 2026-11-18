import { createUserWithEmailAndPassword } from 'firebase/auth';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PhotoPicker } from '../components/PhotoPicker';
import { Button, ErrorBox, Field, TopBar } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { auth, errorText, wakeServer } from '../lib/firebase';
import { PLATFORM_ADMIN_STATE_CODE } from '../lib/appConfig';
import { normalizePhone, normalizeStateCode, stateCodeToEmail } from '../lib/rules';
import { setSignupLock } from '../lib/signupLock';
import { blobToDataUrl, clearDraft, dataUrlToBlob, loadDraft, markPickerOpen, saveDraft } from '../lib/signupDraft';
import { toast } from '../lib/toast';
import { uploadAvatar } from '../lib/upload';

/** State code is recoverable from the hidden login email (la26b1142@cdspass.app). */
function stateCodeFromCurrentUser(): string {
  const local = auth.currentUser?.email?.split('@')[0] ?? '';
  return normalizeStateCode(local) ?? '';
}

export default function Signup({ finish = false }: { finish?: boolean }) {
  const { logout, profile: savedProfile, claims } = useAuth();
  const navigate = useNavigate();
  // Anything typed before the phone closed the app (see lib/signupDraft.ts). Read once.
  const [draft] = useState(() => {
    const d = loadDraft();
    // In "finish" mode the login already exists: only reuse a draft for the same state code.
    if (d && finish && normalizeStateCode(d.stateCode) !== stateCodeFromCurrentUser()) return null;
    return d;
  });
  const steps = finish ? ['Details', 'Photo', 'CDS group'] : ['Details', 'Photo', 'CDS group', 'PIN'];
  const [rawStep, setStep] = useState(draft?.step ?? 0);
  // If sign-up switches to "finish" mode (fewer steps), never point past the last step.
  const step = Math.min(rawStep, steps.length - 1);
  const [dir, setDir] = useState(1);

  const [stateCode, setStateCode] = useState(finish ? stateCodeFromCurrentUser() : draft?.stateCode ?? '');
  const [fullName, setFullName] = useState(draft?.fullName ?? '');
  const [phone, setPhone] = useState(draft?.phone ?? '');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [joinCode, setJoinCode] = useState(draft?.joinCode ?? '');
  // Only the platform admin may start a brand-new group while signing up (first-time setup).
  const [startGroup, setStartGroup] = useState(draft?.startGroup ?? false);
  const [group, setGroup] = useState(draft?.group ?? { name: '', lga: '', state: '' });
  const isPlatformAdmin = normalizeStateCode(stateCode) === PLATFORM_ADMIN_STATE_CODE;
  const creatingGroup = isPlatformAdmin && startGroup;
  /** Set once the server has saved everything; we then wait for the profile to arrive before leaving. */
  const [doneTo, setDoneTo] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [consent, setConsent] = useState(false);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  /** The phone closed the app while the camera/gallery was open. */
  const [wasClosed] = useState(() => !!draft?.pickerOpen);
  const [photoData, setPhotoData] = useState<string | null>(draft?.photo ?? null);

  // Bring back a photo that was already chosen before the app was closed.
  useEffect(() => {
    if (draft?.photo) void dataUrlToBlob(draft.photo).then(setPhoto).catch(() => setPhotoData(null));
  }, [draft]);

  // Save progress on every change (never the PIN).
  useEffect(() => {
    if (doneTo) return;
    saveDraft({ step: rawStep, stateCode, fullName, phone, joinCode, startGroup, group, photo: photoData, pickerOpen: false });
  }, [rawStep, stateCode, fullName, phone, joinCode, startGroup, group, photoData, doneTo]);

  // Wake the free Render server now, so it is ready by the time the form is submitted.
  useEffect(() => wakeServer(), []);

  // Never leave the sign-up lock on if this screen goes away (e.g. log out).
  useEffect(() => () => setSignupLock(false), []);

  // Leave only when the saved profile (and, for excos, the new permissions) has reached this phone.
  // Leaving earlier made the app flash back to "Finish signing up".
  useEffect(() => {
    if (!doneTo) return;
    const profileReady = !!savedProfile;
    const excoReady = savedProfile?.status !== 'approved' || (claims.approved === true && claims.role === savedProfile.role);
    const go = () => {
      clearDraft();
      setSignupLock(false);
      navigate(doneTo, { replace: true });
    };
    if (profileReady && excoReady) {
      go();
      return;
    }
    const t = setTimeout(go, 12000); // safety net: never stay stuck on this screen
    return () => clearTimeout(t);
  }, [doneTo, savedProfile, claims.approved, claims.role, navigate]);

  function validate(i: number): string {
    if (i === 0) {
      if (!normalizeStateCode(stateCode)) return 'Enter your state code like LA/26B/1142.';
      if (fullName.trim().length < 3) return 'Enter your full name exactly as it is on your NYSC ID card.';
      if (!normalizePhone(phone)) return 'Enter a valid Nigerian phone number, e.g. 0803 123 4567.';
    }
    if (i === 1 && !photo) return 'Add a profile picture.';
    if (i === 2) {
      if (creatingGroup) {
        if (group.name.trim().length < 3 || group.lga.trim().length < 2 || group.state.trim().length < 2)
          return 'Fill in the CDS group name, LGA and state.';
      } else if (joinCode.trim().length !== 6) return 'Enter the 6-character CDS group code from your exco.';
    }
    if (i === 3) {
      if (!/^\d{6}$/.test(pin)) return 'Your PIN must be 6 digits.';
      if (pin !== pin2) return 'The two PINs do not match.';
      if (!consent) return 'Please agree before creating your account.';
    }
    return '';
  }

  function next() {
    const err = validate(step);
    setError(err);
    if (err) return;
    if (step < steps.length - 1) {
      setDir(1);
      setStep(step + 1);
    } else {
      void submit();
    }
  }

  function back() {
    setError('');
    setDir(-1);
    setStep(Math.max(0, step - 1));
  }

  async function submit() {
    const sc = normalizeStateCode(stateCode)!;
    setError('');
    setSignupLock(finish ? 'finish' : 'signup');
    try {
      let uid = auth.currentUser?.uid;
      if (!uid) {
        setBusy('Creating your account…');
        uid = (await createUserWithEmailAndPassword(auth, stateCodeToEmail(sc), pin)).user.uid;
      }

      setBusy('Uploading your photo…');
      const photoURL = await uploadAvatar(uid, photo!);

      setBusy('Saving your details…');
      const profile = { stateCode: sc, fullName: fullName.trim(), phone: normalizePhone(phone)!, photoURL };
      let to = '/pending';
      try {
        const r = creatingGroup
          ? await api.registerPlatformAdmin({ ...profile, group })
          : await api.registerMember({ ...profile, joinCode: joinCode.trim().toUpperCase() });
        if (r.status === 'approved' && r.role === 'exco') {
          to = '/exco';
          if ('joinCode' in r) toast(`${r.groupName} is ready`, 'success', `Share group code ${r.joinCode} with your members.`);
          else toast(`You are the main exco for ${r.groupName}`, 'success', 'You can now set up the group and promote other members.');
        } else {
          toast(`Joined ${r.groupName}`, 'success', 'An exco will approve you at your next CDS.');
        }
      } catch (e) {
        // A slow first try may have finished on the server after the phone gave up. Then the profile
        // already exists, and that is a success, not an error.
        if ((e as { code?: string }).code !== 'functions/already-exists' || !/already registered/i.test(String((e as Error).message))) throw e;
      }
      setBusy('Opening your account…');
      setDoneTo(to);
    } catch (e) {
      // The login may exist now even though the profile doesn't. Keep everything typed so far and
      // let them press the button again; it continues from where it stopped.
      setSignupLock(auth.currentUser ? 'finish' : false);
      setError(errorText(e));
      setBusy('');
    }
  }

  return (
    <div className="screen">
      <TopBar
        title={finish ? 'Finish signing up' : 'Create account'}
        back={step === 0 ? (finish ? undefined : '/') : undefined}
        right={
          finish ? (
            <button onClick={logout} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold">
              Log out
            </button>
          ) : undefined
        }
        sub={`Step ${step + 1} of ${steps.length} · ${steps[step]}`}
      />

      <div className="px-5 pt-4">
        <div className="flex gap-1.5">
          {steps.map((s, i) => (
            <div key={s} className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${i <= step ? 'bg-green' : 'bg-line'}`} />
          ))}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden px-5 pt-6">
        {/* Enter-only animation: a step can never get stuck half-way out (that caused the blank PIN screen). */}
        <motion.div
            key={step}
            initial={{ x: dir * 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="space-y-5"
          >
            {step === 0 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Your NYSC details</h2>
                  <p className="text-muted">Your state code is what you log in with.</p>
                </div>
                <Field
                  label="State code"
                  placeholder="LA/26B/1142"
                  autoCapitalize="characters"
                  value={stateCode}
                  disabled={finish}
                  onChange={(e) => setStateCode(e.target.value)}
                />
                <Field
                  label="Full name (as on your NYSC ID card)"
                  placeholder="Adebayo Tolulope Grace"
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
                <Field
                  label="Phone number"
                  type="tel"
                  inputMode="tel"
                  placeholder="0803 123 4567"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </>
            )}

            {step === 1 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Profile picture</h2>
                  <p className="text-muted">This shows on the exco's screen when you thumbprint.</p>
                </div>
                {wasClosed && !photo && (
                  <p className="rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">
                    Your phone closed the app while the camera was open, but your details are saved. Try
                    <b> Choose photo</b> and pick a selfie from your gallery: it uses less memory.
                  </p>
                )}
                <PhotoPicker
                  value={photo}
                  onPickerOpen={markPickerOpen}
                  onChange={(b, err) => {
                    setPhoto(b);
                    setError(err ?? '');
                    if (b) void blobToDataUrl(b).then(setPhotoData).catch(() => setPhotoData(null));
                    else setPhotoData(null);
                  }}
                />
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Your CDS group</h2>
                  <p className="text-muted">Ask your CDS exco for the group code.</p>
                </div>
                {isPlatformAdmin && (
                  <div className="grid grid-cols-2 gap-2 rounded-2xl bg-line p-1.5">
                    {[false, true].map((m) => (
                      <button
                        key={String(m)}
                        type="button"
                        onClick={() => setStartGroup(m)}
                        className={`h-12 rounded-xl text-sm font-bold transition-colors ${startGroup === m ? 'bg-green text-white shadow-card' : 'text-muted'}`}
                      >
                        {m ? 'Start my CDS group' : 'Join with code'}
                      </button>
                    ))}
                  </div>
                )}
                {creatingGroup ? (
                  <>
                    <Field label="CDS group name" placeholder="Digital Skills CDS" value={group.name} onChange={(e) => setGroup({ ...group, name: e.target.value })} />
                    <Field label="LGA" placeholder="Ikorodu" value={group.lga} onChange={(e) => setGroup({ ...group, lga: e.target.value })} />
                    <Field label="State" placeholder="Lagos" value={group.state} onChange={(e) => setGroup({ ...group, state: e.target.value })} />
                    <p className="rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">
                      Platform admin setup: you become this group's main exco. Create other groups later in Exco → Settings.
                    </p>
                  </>
                ) : (
                  <Field
                    label="CDS group code"
                    placeholder="K7Q2MX"
                    autoCapitalize="characters"
                    maxLength={6}
                    className="input text-center text-2xl font-extrabold tracking-[0.4em]"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  />
                )}
              </>
            )}

            {step === 3 && (
              <>
                <div>
                  <h2 className="text-2xl font-extrabold">Create a 6-digit PIN</h2>
                  <p className="text-muted">You'll log in with your state code and this PIN.</p>
                </div>
                <Field
                  label="PIN"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="new-password"
                  placeholder="••••••"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                />
                <Field
                  label="Confirm PIN"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="new-password"
                  placeholder="••••••"
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
                />
                <label className="flex gap-3 rounded-2xl bg-card p-4 text-sm shadow-card">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-5 w-5 shrink-0 accent-green"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    I agree that my name, state code, phone number and photo are stored by CDS Pass and shown to my
                    CDS excos for attendance only. CDS Pass is an independent tool, not run by NYSC.
                  </span>
                </label>
              </>
            )}
          </motion.div>
      </div>

      <div className="space-y-3 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
        <ErrorBox>{error}</ErrorBox>
        {busy ? (
          <Button loading>{busy}</Button>
        ) : (
          <div className="flex gap-3">
            {step > 0 && (
              <Button variant="outline" full={false} className="w-28" onClick={back}>
                Back
              </Button>
            )}
            <Button onClick={next}>{step === steps.length - 1 ? 'Create account' : 'Continue'}</Button>
          </div>
        )}
        {busy && <p className="text-center text-sm font-semibold text-muted">{busy}</p>}
        {!finish && step === 0 && (
          <p className="text-center text-sm">
            Already registered?{' '}
            <Link to="/login" className="font-bold text-green">
              Log in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
