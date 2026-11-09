import { QRCodeSVG } from 'qrcode.react';
import { useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, TopBar } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup, useGroupMembers } from '../../hooks/useLive';
import { memberQR } from '../../lib/rules';

/** Printable QR cards for members without smartphones. Print → cut → laminate. */
export default function PrintCards() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const members = useGroupMembers(me.groupId);
  const [search, setSearch] = useState('');

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (members ?? []).filter(
      (m) => m.status === 'approved' && (!q || m.fullName.toLowerCase().includes(q) || m.stateCode.toLowerCase().includes(q)),
    );
  }, [members, search]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print">
        <TopBar title="Print member cards" back="/exco/members" sub="Search to print only the people who need one" />
        <div className="flex gap-3 p-4">
          <input className="input flex-1" placeholder="Search name or state code" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search members" />
          <Button full={false} onClick={() => window.print()}>
            Print {list.length}
          </Button>
        </div>
      </div>

      <div className="print-grid grid gap-4 p-4 sm:grid-cols-2">
        {list.map((m) => (
          <div key={m.uid} className="print-card theme-light flex items-center gap-4 rounded-3xl bg-white p-4 text-ink shadow-card">
            <div className="flex-1">
              <p className="text-[10px] font-extrabold tracking-widest text-green">CDS PASS · {group?.name}</p>
              <div className="mt-2 flex items-center gap-2">
                <Avatar src={m.photoURL} name={m.fullName} size={40} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold">{m.fullName}</p>
                  <p className="text-xs font-semibold text-muted">{m.stateCode}</p>
                </div>
              </div>
              <p className="mt-3 text-[10px] text-muted">Show this card at the door and at the thumbprint table.</p>
            </div>
            <QRCodeSVG value={memberQR(m.uid)} size={110} level="M" fgColor="#03301A" />
          </div>
        ))}
      </div>
    </div>
  );
}
