import { motion } from 'framer-motion';
import { QRCodeCanvas } from 'qrcode.react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TagCard3D } from '../../components/TagCard3D';
import { Button, Page, TopBar } from '../../components/ui';
import { useMyDay } from '../../hooks/useMyDay';
import { aheadOf, batchLabel, memberQR } from '../../lib/rules';
import { saveTag, shareTag, type TagImageInput } from '../../lib/tagImage';
import { toast } from '../../lib/toast';

export default function MyTag() {
  const { me, group, session, att, status, tag } = useMyDay();
  const qrBox = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<'' | 'share' | 'save'>('');

  const input = (): TagImageInput => ({
    name: me.fullName,
    stateCode: me.stateCode,
    groupName: group?.name,
    tag,
    status,
    photoURL: me.photoURL,
    qrCanvas: qrBox.current?.querySelector('canvas') ?? null,
  });

  async function onShare() {
    setBusy('share');
    try {
      const r = await shareTag(input());
      if (r === 'saved') toast('Tag saved as an image', 'success', 'Find it in your downloads or gallery.');
    } catch {
      toast('Could not create the image', 'error');
    } finally {
      setBusy('');
    }
  }

  async function onSave() {
    setBusy('save');
    try {
      await saveTag(input());
      toast('Tag saved as an image', 'success', 'Find it in your downloads or gallery.');
    } catch {
      toast('Could not create the image', 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={`min-h-[100dvh] transition-colors duration-500 ${status === 'turn' ? 'bg-green' : 'bg-paper'}`}>
      <TopBar title="My tag" sub={group?.name} />
      <Page className="space-y-5">
        <TagCard3D
          uid={me.uid}
          name={me.fullName}
          stateCode={me.stateCode}
          photoURL={me.photoURL}
          groupName={group?.name}
          tag={tag}
          status={status}
        />

        {/* Hidden high-resolution QR used to draw the shareable image */}
        <div ref={qrBox} className="hidden" aria-hidden="true">
          <QRCodeCanvas value={memberQR(me.uid)} size={600} level="M" fgColor="#03301A" marginSize={0} />
        </div>

        <div className="mx-auto grid w-full max-w-[340px] grid-cols-2 gap-3">
          <Button loading={busy === 'share'} onClick={onShare}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
            </svg>
            Share
          </Button>
          <Button variant="light" loading={busy === 'save'} onClick={onSave}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
            </svg>
            Save image
          </Button>
        </div>

        {att ? (
          <motion.div className="grid grid-cols-2 gap-3">
            <div className="card !p-4">
              <p className="text-xs font-semibold text-muted">Now calling</p>
              <p className="text-2xl font-extrabold text-green">{batchLabel(session?.batch)}</p>
            </div>
            <div className="card !p-4">
              <p className="text-xs font-semibold text-muted">{status === 'done' ? 'Done at' : 'Ahead of you'}</p>
              <p className="text-2xl font-extrabold">
                {status === 'done'
                  ? att.doneAt?.toDate().toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' }) ?? '✓'
                  : status === 'turn'
                    ? 'Go now'
                    : aheadOf(att, session?.batch)}
              </p>
            </div>
          </motion.div>
        ) : (
          <Link to="/scan" className="block rounded-2xl bg-green py-4 text-center font-bold text-white">
            Scan in to get your number
          </Link>
        )}

        <p className={`text-center text-sm ${status === 'turn' ? 'text-white' : 'text-muted'}`}>
          At the table, tap the card to show your QR. The exco scans it and checks your NYSC ID card.
        </p>
      </Page>
    </div>
  );
}
