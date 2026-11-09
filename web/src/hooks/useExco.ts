import { useMemo } from 'react';
import { useMe } from './useAuth';
import { useAttendees, useGroup, useSession } from './useLive';

/** Live numbers for the exco screens. */
export function useExcoDay() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const session = useSession(me.groupId);
  const attendees = useAttendees(me.groupId);

  const stats = useMemo(() => {
    const list = attendees ?? [];
    return {
      present: list.length,
      done: list.filter((a) => a.status === 'done').length,
      waiting: list.filter((a) => a.status === 'waiting').length,
      priority: list.filter((a) => a.priority).length,
      priorityWaiting: list.filter((a) => a.priority && a.status === 'waiting').length,
      manual: list.filter((a) => a.method === 'manual').length,
    };
  }, [attendees]);

  return { me, group, session, attendees, stats, open: session?.status === 'open' };
}
