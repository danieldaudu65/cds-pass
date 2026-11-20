import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { ExcoHeader } from '../../components/ExcoHeader';
import { Button, ErrorBox, Field, Icon, Page, Pill, Select } from '../../components/ui';
import { useMe } from '../../hooks/useAuth';
import { useGroup } from '../../hooks/useLive';
import { api } from '../../lib/api';
import { errorText } from '../../lib/firebase';
import { toast } from '../../lib/toast';

type Audience = 'all' | 'unpaid' | 'pending' | 'excos';

const TEMPLATES: { emoji: string; label: string; title: string; body: string; link: string; audience?: Audience }[] = [
  { emoji: '☀️', label: 'Good morning', title: 'Good morning corpers ☀️', body: 'Have a great day. See you at CDS!', link: '/home' },
  { emoji: '💼', label: 'Job alert', title: 'Job alert 💼', body: 'A new opportunity is available. Ask the excos for details.', link: '/home' },
  { emoji: '💰', label: 'Dues reminder', title: 'Dues reminder 💰', body: 'Please pay your CDS dues in the app before the next meeting.', link: '/dues', audience: 'unpaid' },
  { emoji: '📍', label: 'Venue change', title: 'Venue change 📍', body: 'This week’s CDS meeting holds at a new venue: ', link: '/home' },
  { emoji: '⚠️', label: 'Meeting cancelled', title: 'CDS meeting cancelled ⚠️', body: 'There will be no CDS meeting this week. More details soon.', link: '/home' },
];

const AUDIENCES: { value: Audience; label: string; hint: string }[] = [
  { value: 'all', label: 'Everyone (approved members)', hint: 'All approved corpers in this CDS' },
  { value: 'unpaid', label: 'Haven’t paid dues', hint: 'Members who still owe any open dues' },
  { value: 'pending', label: 'Waiting for approval', hint: 'People who signed up but aren’t approved yet' },
  { value: 'excos', label: 'Excos only', hint: 'Just the excos' },
];

const LINKS = [
  { value: '/home', label: 'Home' },
  { value: '/dues', label: 'Dues' },
  { value: '/tag', label: 'My tag' },
  { value: '/scan', label: 'Scan in' },
];

type Sent = Awaited<ReturnType<typeof api.listGroupMessages>>['messages'][number];

/** Main exco: send a custom push message to members ("Good morning corpers", "Job alert" …). */
export default function Messages() {
  const me = useMe();
  const group = useGroup(me.groupId);
  const isMainExco = (group?.mainExcoUid ?? group?.createdBy) === me.uid;

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>('all');
  const [link, setLink] = useState('/home');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Sent[] | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.listGroupMessages({});
      setHistory(r.messages);
      setLeft(r.left);
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    if (isMainExco) void load();
  }, [isMainExco, load]);

  async function send() {
    setError('');
    if (title.trim().length < 3 || body.trim().length < 3) return setError('Write a title and a message.');
    const who = AUDIENCES.find((a) => a.value === audience)!.label.toLowerCase();
    if (!confirm(`Send "${title.trim()}" to ${who}?`)) return;
    setBusy(true);
    try {
      const r = await api.sendGroupMessage({ title: title.trim(), body: body.trim(), audience, link });
      toast(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}`, 'success', `${r.left} message${r.left === 1 ? '' : 's'} left today.`);
      setTitle('');
      setBody('');
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (group && !isMainExco) {
    return (
      <>
        <ExcoHeader title="Send a message" />
        <Page>
          <div className="card text-center text-sm text-muted">Only the main exco can send messages to members.</div>
        </Page>
      </>
    );
  }

  return (
    <>
      <ExcoHeader title="Send a message" sub={left === null ? 'Push notification to members' : `${left} of 5 left today`} />
      <Page className="space-y-4">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              onClick={() => {
                setTitle(t.title);
                setBody(t.body);
                setLink(t.link);
                if (t.audience) setAudience(t.audience);
              }}
              className="h-10 shrink-0 rounded-full bg-card px-4 text-sm font-bold text-green shadow-card active:scale-95"
            >
              {t.emoji} {t.label}
            </button>
          ))}
        </div>

        <div className="card space-y-4">
          <Field label="Title" maxLength={60} placeholder="Good morning corpers" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div>
            <label htmlFor="msg-body" className="label">
              Message
            </label>
            <textarea
              id="msg-body"
              maxLength={300}
              rows={4}
              placeholder="Write your message…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="input !h-auto resize-none py-3"
            />
            <p className="mt-1 text-right text-xs text-muted">{body.length}/300</p>
          </div>
          <Select<Audience>
            label="Send to"
            value={audience}
            onChange={setAudience}
            options={AUDIENCES.map((a) => ({ value: a.value, label: a.label, hint: a.hint }))}
          />
          <Select label="When they tap it, open" value={link} onChange={setLink} options={LINKS} />

          {/* Preview of how it looks on a phone */}
          <AnimatePresence>
            {(title || body) && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-2xl bg-line p-3">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted">Preview</p>
                <div className="flex gap-3 rounded-2xl bg-card p-3 shadow-card">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-green text-xs font-extrabold text-white">CDS</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{title || 'Title'}</p>
                    <p className="line-clamp-3 text-sm text-muted">{body || 'Message'}</p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <ErrorBox>{error}</ErrorBox>
          <Button loading={busy} disabled={left === 0} onClick={send}>
            <Icon name="bell" /> Send message
          </Button>
          <p className="text-center text-xs text-muted">Up to 5 messages a day, so members don’t turn notifications off. Only members with alerts on receive it.</p>
        </div>

        <div className="card !p-0">
          <p className="px-5 pb-2 pt-4 font-bold">Sent messages</p>
          {history === null ? (
            <div className="mx-5 mb-4 h-14 animate-pulse rounded-2xl bg-line" />
          ) : history.length === 0 ? (
            <p className="px-5 pb-4 text-sm text-muted">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {history.map((m) => (
                <li key={m.id} className="space-y-1 px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold">{m.title}</p>
                    <Pill tone="muted">{m.recipients} people</Pill>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted">{m.body}</p>
                  <p className="text-xs text-muted">
                    {m.sentByName} ·{' '}
                    {m.sentAt ? new Date(m.sentAt).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Page>
    </>
  );
}
