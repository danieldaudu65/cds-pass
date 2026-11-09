import { motion } from 'framer-motion';
import { lazy, Suspense, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui';
import { canUse3D } from '../lib/device';

const Hero3D = lazy(() => import('../components/Hero3D'));

/** Lightweight stand-in for phones that can't run 3D. */
function FlatHero() {
  return (
    <div className="grid h-full place-items-center">
      <motion.div
        animate={{ y: [0, -10, 0], rotate: [-4, 3, -4] }}
        transition={{ repeat: Infinity, duration: 5, ease: 'easeInOut' }}
        className="flex aspect-[5/7] w-48 flex-col rounded-[26px] bg-gradient-to-br from-green to-green-dark p-5 text-white shadow-lift"
      >
        <span className="text-xs font-extrabold tracking-widest">CDS PASS</span>
        <span className="mt-auto text-center text-xs font-bold tracking-[0.25em] text-green-mid">YOUR NUMBER</span>
        <span className="text-center text-7xl font-extrabold">14</span>
        <span className="mt-auto theme-light rounded-xl bg-white py-2 text-center text-xs font-extrabold text-green">IT'S YOUR TURN ✓</span>
      </motion.div>
    </div>
  );
}

const points = [
  { t: 'Scan in at the door', d: 'Your number is given in the order you arrive. No more queueing for tags.' },
  { t: 'Sit and relax', d: 'Your phone buzzes when your batch is called to thumbprint.' },
  { t: 'Fair for everyone', d: 'Nobody can jump the line. Priority for pregnant and nursing mothers.' },
];

export default function Welcome() {
  const nav = useNavigate();
  const use3D = useMemo(canUse3D, []);

  return (
    <div className="screen bg-green-dark text-white lg:max-w-6xl lg:flex-row">
      <div className="grid-bg relative h-[46dvh] min-h-[320px] lg:h-auto lg:w-1/2">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(14,127,70,.8),transparent_65%)]" />
        <div className="relative h-full">
          {use3D ? (
            <Suspense fallback={<FlatHero />}>
              <Hero3D />
            </Suspense>
          ) : (
            <FlatHero />
          )}
        </div>
      </div>

      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        className="flex flex-1 flex-col rounded-t-[36px] bg-paper px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-8 text-ink lg:w-1/2 lg:justify-center lg:rounded-none lg:px-14 lg:py-14"
      >
        <h1 className="text-[34px] font-extrabold leading-[1.05] tracking-tight lg:text-5xl">
          No more queueing
          <br />
          <span className="text-green">for numbers at CDS.</span>
        </h1>

        <ul className="mt-6 space-y-4">
          {points.map((p, i) => (
            <motion.li
              key={p.t}
              initial={{ x: -20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.15 + i * 0.1 }}
              className="flex gap-3"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-green text-sm font-extrabold text-white">{i + 1}</span>
              <div>
                <p className="font-bold">{p.t}</p>
                <p className="text-sm text-muted">{p.d}</p>
              </div>
            </motion.li>
          ))}
        </ul>

        <div className="mt-auto space-y-3 pt-8 lg:mt-10 lg:max-w-sm">
          <Button onClick={() => nav('/signup')}>Get started</Button>
          <Button variant="outline" onClick={() => nav('/login')}>
            I already have an account
          </Button>
          <p className="pt-2 text-center text-xs text-muted">Independent tool for CDS groups. Not affiliated with NYSC.</p>
        </div>
      </motion.div>
    </div>
  );
}
