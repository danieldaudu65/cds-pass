import { signInWithEmailAndPassword } from 'firebase/auth';
import { motion } from 'framer-motion';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, ErrorBox, Field, TopBar } from '../components/ui';
import { auth, errorText } from '../lib/firebase';
import { normalizeStateCode, stateCodeToEmail } from '../lib/rules';

export default function Login() {
  const [stateCode, setStateCode] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const sc = normalizeStateCode(stateCode);
    if (!sc) return setError('Enter your state code like LA/26B/1142.');
    if (!/^\d{6}$/.test(pin)) return setError('Your PIN is 6 digits.');
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, stateCodeToEmail(sc), pin);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <TopBar title="Log in" back="/" />
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-1 flex-col gap-5 px-5 pb-8 pt-6"
      >
        <div>
          <h2 className="text-2xl font-extrabold">Welcome back</h2>
          <p className="text-muted">Use your NYSC state code and your 6-digit PIN.</p>
        </div>
        <Field
          label="State code"
          placeholder="LA/26B/1142"
          autoCapitalize="characters"
          autoComplete="username"
          value={stateCode}
          onChange={(e) => setStateCode(e.target.value)}
        />
        <Field
          label="PIN"
          type="password"
          inputMode="numeric"
          pattern="\d*"
          maxLength={6}
          autoComplete="current-password"
          placeholder="••••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <ErrorBox>{error}</ErrorBox>
        <div className="mt-auto space-y-3">
          <Button type="submit" loading={busy}>
            Log in
          </Button>
          <p className="text-center text-sm text-muted">
            Forgot your PIN? Ask your CDS exco to reset it after checking your ID card.
          </p>
          <p className="text-center text-sm">
            New here?{' '}
            <Link to="/signup" className="font-bold text-green">
              Create an account
            </Link>
          </p>
        </div>
      </motion.form>
    </div>
  );
}
