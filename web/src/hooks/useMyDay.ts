import { useEffect, useRef } from 'react';
import { isTurn, tagLabel } from '../lib/rules';
import { batchTurnToast } from '../lib/toast';
import { useMe } from './useAuth';
import { useGroup, useMyAttendee, useSession } from './useLive';

/** Everything a member needs for today: group, session, my tag and whether it's my turn. */
export function useMyDay() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const session = useSession(me.groupId);
  const att = useMyAttendee(me.groupId, me.uid);

  const turn = session?.status === 'open' && !!att && isTurn(att, session.batch);
  const status: 'none' | 'waiting' | 'turn' | 'done' = !att ? 'none' : att.status === 'done' ? 'done' : turn ? 'turn' : 'waiting';

  // Buzz the phone the moment my batch is called (works whenever the site is open).
  const wasTurn = useRef(turn);
  useEffect(() => {
    if (turn && !wasTurn.current) {
      navigator.vibrate?.([400, 150, 400, 150, 400]);
      batchTurnToast("It's your turn!", 'Go to the thumbprint table and show your tag.');
    }
    wasTurn.current = turn;
  }, [turn]);

  return { me, group, session, att, turn, status, tag: att ? tagLabel(att) : null };
}
