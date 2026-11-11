import { createUserWithEmailAndPassword } from 'firebase/auth';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PhotoPicker } from '../components/PhotoPicker';
import { Button, ErrorBox, Field, TopBar } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { api } from '../lib/api';
import { auth, errorText } from '../lib/firebase';
import { PLATFORM_ADMIN_STATE_CODE } from '../lib/appConfig';
import { normalizePhone, normalizeStateCode, stateCodeToEmail } from '../lib/rules';
import { setSignupLock } from '../lib/signupLock';
import { toast } from '../lib/toast';
import { uploadAvatar } from '../lib/upload';

type Mode = 'join' | 'create';

/** State code is recoverable from the hidden login email (la26b1142@cdspass.app). */
function stateCodeFromCurrentUser(): string {
  const local = auth.currentUser?.email?.split('@')[0] ?? '';
  return normalizeStateCode(local) ?? '';
}

export default function Signup({ finish = false }: { finish?: boolean }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const steps = finish ? ['Details', 'Photo', 'CDS group'] : ['Details', 'Photo', 'CDS group', 'PIN'];
  const [rawStep, setStep] = useState(0);
  // If sign-up switches to "finish" mode (fewer steps), never point past the last step.
  const step = Math.min(rawStep, steps.length - 1);
  const [dir, setDir] = useState(1);

  const [stateCode, setStateCode] = useState(finish ? stateCodeFromCurrentUser() : '');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [mode, setMode] = useState<Mode>('join');
  const [joinCode, setJoinCode] = useState('');
  const [group, setGroup] = useState({ name: '', lga: '', state: '' });
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [consent, setConsent] = useState(false);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const canCreateGroup = normalizeStateCode(stateCode) === PLATFORM_ADMIN_STATE_CODE;

  function validate(i: number): string {
    if (i === 0) {
      if (!normalizeStateCode(stateCode)) return 'Enter your state code like LA/26B/1142.';
      if (fullName.trim().length < 3) return 'Enter your full name exactly as it is on your NYSC ID card.';
      if (!normalizePhone(phone)) return 'Enter a valid Nigerian phone number, e.g. 0803 123 4567.';
    }
    if (i === 1 && !photo) return 'Add a profile picture.';
    if (i === 2) {
      if (mode === 'join' && joinCode.trim().length !== 6) return 'Enter the 6-character CDS group code from your exco.';
      if (mode === 'create' && (group.name.trim().length < 3 || group.lga.trim().length < 2 || group.state.trim().length < 2))
        return 'Fill in the CDS group name, LGA and state.';
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
    let nextPath: string | undefined;
    setSignupLock(finish ? 'finish' : 'signup');
    try {
      let uid = auth.currentUser?.uid;
      if (!finish) {
        setBusy('Creating your account…');
        uid = (await createUserWithEmailAndPassword(auth, stateCodeToEmail(sc), pin)).user.uid;
      }
      if (!uid) throw new Error('Please log in again.');

      setBusy('Uploading your photo…');
      const photoURL = await uploadAvatar(uid, photo!);

      setBusy('Saving your details…');
      const profile = { stateCode: sc, fullName: fullName.trim(), phone: normalizePhone(phone)!, photoURL };
      if (mode === 'join') {
        const r = await api.registerMember({ ...profile, joinCode: joinCode.trim().toUpperCase() });
        toast(`Joined ${r.groupName}`, 'success', 'An exco will approve you at your next CDS.');
        nextPath = '/pending';
      } else {
        const r = await api.createGroup({ ...profile, group });
        toast('CDS group created', 'success', `Share this group code with your members: ${r.joinCode}`);
        nextPath = '/exco';
      }
      // AuthProvider refreshes claims when it observes an approved profile.
      // Do not hold the signup screen open waiting for an extra token refresh.
      setBusy('');
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    } finally {
      setSignupLock(false);
      if (nextPath) navigate(nextPath, { replace: true });
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
                <PhotoPicker
                  value={photo}
                  onChange={(b, err) => {
                    setPhoto(b);
                    setError(err ?? '');
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
                <div className={`grid gap-2 rounded-2xl bg-line p-1.5 ${canCreateGroup ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  {(canCreateGroup ? (['join', 'create'] as Mode[]) : (['join'] as Mode[])).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`h-12 rounded-xl text-sm font-bold transition-colors ${mode === m ? 'bg-green text-white shadow-card' : 'text-muted'}`}
                    >
                      {m === 'join' ? 'Join with code' : "I'm an exco"}
                    </button>
                  ))}
                </div>
                {mode === 'join' ? (
                  <Field
                    label="CDS group code"
                    placeholder="K7Q2MX"
                    autoCapitalize="characters"
                    maxLength={6}
                    className="input text-center text-2xl font-extrabold tracking-[0.4em]"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  />
                ) : (
                  <>
                    <Field
                      label="CDS group name"
                      placeholder="Digital Skills CDS"
                      value={group.name}
                      onChange={(e) => setGroup({ ...group, name: e.target.value })}
                    />
                    <Field label="LGA" placeholder="Ikorodu" value={group.lga} onChange={(e) => setGroup({ ...group, lga: e.target.value })} />
                    <Field label="State" placeholder="Lagos" value={group.state} onChange={(e) => setGroup({ ...group, state: e.target.value })} />
                    <p className="rounded-2xl bg-warn-bg px-4 py-3 text-sm text-warn">
                      You'll be the first exco of this group and can add other excos later.
                    </p>
                  </>
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
