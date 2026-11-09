import { motion } from 'framer-motion';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

const steps = [
  { t: 'Account created', d: 'Your details and photo are saved.' },
  { t: 'Exco review', d: 'An exco checks your name, state code and photo.' },
  { t: 'Approved', d: 'You can scan in and get your number at CDS.' },
];

/** Shown until an exco approves the member from the Members screen. Updates by itself. */
export default function Pending() {
  const { profile, logout } = useAuth();
  if (!profile) return null;
  const rejected = profile.status === 'rejected';

  return (
    <div className="screen bg-green-dark text-white">
      <div className="grid-bg flex flex-1 flex-col items-center px-6 pb-8 pt-[max(2.5rem,env(safe-area-inset-top))] text-center">
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="relative">
          {!rejected && (
            <motion.span
              className="absolute -inset-3 rounded-full border-4 border-khaki/70"
              animate={{ scale: [1, 1.12, 1], opacity: [0.8, 0.2, 0.8] }}
              transition={{ repeat: Infinity, duration: 2.2 }}
            />
          )}
          <Avatar src={profile.photoURL} name={profile.fullName} size={112} ring />
        </motion.div>
        <h1 className="mt-6 text-2xl font-extrabold">{profile.fullName}</h1>
        <p className="font-semibold text-green-mid">{profile.stateCode}</p>

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.15 }}
          className="mt-8 w-full rounded-3xl bg-card p-6 text-left text-ink shadow-lift"
        >
          {rejected ? (
            <div className="text-center">
              <p className="text-lg font-extrabold text-bad">Not approved</p>
              <p className="mt-1 text-sm text-muted">
                An exco could not confirm your details. Speak to your CDS exco with your NYSC ID card.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-lg font-extrabold">Under review</p>
                <motion.span
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ repeat: Infinity, duration: 1.6 }}
                  className="rounded-full bg-warn-bg px-3 py-1 text-xs font-bold text-warn"
                >
                  Waiting for exco
                </motion.span>
              </div>
              <ol className="mt-5 space-y-4">
                {steps.map((s, i) => {
                  const done = i === 0;
                  const now = i === 1;
                  return (
                    <li key={s.t} className="flex gap-3">
                      <span
                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-extrabold ${
                          done ? 'bg-green text-white' : now ? 'bg-warn-bg text-warn' : 'bg-line text-muted'
                        }`}
                      >
                        {done ? '✓' : i + 1}
                      </span>
                      <div>
                        <p className={`font-bold ${!done && !now ? 'text-muted' : ''}`}>{s.t}</p>
                        <p className="text-sm text-muted">{s.d}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-5 rounded-2xl bg-paper p-3 text-sm text-muted">
                This screen updates by itself the moment you're approved. You can close the app and come back later.
              </p>
            </>
          )}
        </motion.div>

        <div className="mt-auto w-full pt-8">
          <Button variant="light" onClick={logout}>
            Log out
          </Button>
        </div>
      </div>
    </div>
  );
}
