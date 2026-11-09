/**
 * Draws the member's tag as a PNG (1080 × 1350, WhatsApp/Instagram friendly)
 * and shares it, or downloads it where sharing files isn't supported.
 */
export interface TagImageInput {
  name: string;
  stateCode: string;
  groupName?: string;
  tag: string | null;
  status: 'none' | 'waiting' | 'turn' | 'done';
  photoURL: string | null;
  /** A <canvas> that already has the member's QR code drawn on it. */
  qrCanvas: HTMLCanvasElement | null;
}

const W = 1080;
const H = 1350;
const FONT = '"Plus Jakarta Sans", system-ui, sans-serif';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export async function drawTag(input: TagImageInput): Promise<Blob> {
  await document.fonts?.ready;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  // Background
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0E7F46');
  bg.addColorStop(0.55, '#0B6B3A');
  bg.addColorStop(1, '#03301A');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  for (let x = 18; x < W; x += 36) for (let y = 18; y < H; y += 36) g.fillRect(x, y, 3, 3);

  // Header
  g.fillStyle = '#FFFFFF';
  g.font = `800 44px ${FONT}`;
  g.textAlign = 'left';
  g.fillText('CDS PASS', 80, 120);
  if (input.groupName) {
    g.font = `700 30px ${FONT}`;
    const w = g.measureText(input.groupName).width + 48;
    g.fillStyle = 'rgba(255,255,255,0.16)';
    roundRect(g, W - 80 - w, 78, w, 60, 30);
    g.fill();
    g.fillStyle = '#FFFFFF';
    g.textAlign = 'center';
    g.fillText(input.groupName, W - 80 - w / 2, 119);
  }

  // Photo + name
  const cx = 170;
  const cy = 270;
  const rad = 88;
  g.save();
  g.beginPath();
  g.arc(cx, cy, rad + 10, 0, Math.PI * 2);
  g.fillStyle = '#FFFFFF';
  g.fill();
  g.beginPath();
  g.arc(cx, cy, rad, 0, Math.PI * 2);
  g.clip();
  const photo = input.photoURL ? await loadImage(input.photoURL) : null;
  if (photo) {
    g.drawImage(photo, cx - rad, cy - rad, rad * 2, rad * 2);
  } else {
    g.fillStyle = '#E3F2E8';
    g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    g.fillStyle = '#0B6B3A';
    g.font = `800 64px ${FONT}`;
    g.textAlign = 'center';
    const initials = input.name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    g.fillText(initials, cx, cy + 22);
  }
  g.restore();

  g.textAlign = 'left';
  g.fillStyle = '#FFFFFF';
  g.font = `800 52px ${FONT}`;
  let name = input.name;
  while (g.measureText(name).width > W - 380 && name.length > 4) name = name.slice(0, -2);
  if (name !== input.name) name = name.trimEnd() + '…';
  g.fillText(name, 300, 260);
  g.fillStyle = '#CFE6D6';
  g.font = `700 36px ${FONT}`;
  g.fillText(input.stateCode, 300, 315);

  // Big number
  g.textAlign = 'center';
  g.fillStyle = '#CFE6D6';
  g.font = `700 30px ${FONT}`;
  g.fillText('Y O U R   N U M B E R', W / 2, 470);
  g.font = `800 250px ${FONT}`;
  g.fillStyle = '#053D20';
  g.fillText(input.tag ?? '—', W / 2 + 6, 700 + 10);
  g.fillStyle = '#FFFFFF';
  g.fillText(input.tag ?? '—', W / 2, 700);

  // Status pill
  const statusText = {
    none: 'Not checked in today',
    waiting: 'Waiting for my batch',
    turn: "It's my turn ✓",
    done: 'Thumbprinted ✓',
  }[input.status];
  g.font = `800 34px ${FONT}`;
  const sw = g.measureText(statusText).width + 80;
  g.fillStyle = input.status === 'waiting' ? '#C9B783' : '#FFFFFF';
  roundRect(g, (W - sw) / 2, 750, sw, 76, 38);
  g.fill();
  g.fillStyle = input.status === 'waiting' ? '#03301A' : '#0B6B3A';
  g.fillText(statusText, W / 2, 800);

  // QR on white
  const qs = 300;
  const qx = (W - qs - 60) / 2;
  const qy = 880;
  g.fillStyle = '#FFFFFF';
  roundRect(g, qx, qy, qs + 60, qs + 60, 36);
  g.fill();
  if (input.qrCanvas) {
    g.imageSmoothingEnabled = false;
    g.drawImage(input.qrCanvas, qx + 30, qy + 30, qs, qs);
  }

  // Footer
  const date = new Date().toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
  g.fillStyle = '#CFE6D6';
  g.font = `600 28px ${FONT}`;
  g.fillText(`${date} · Show this with your NYSC ID card`, W / 2, H - 60);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not create image'))), 'image/png'));
}

/** Opens the phone's share sheet (WhatsApp, etc). Falls back to downloading the PNG. */
export async function shareTag(input: TagImageInput): Promise<'shared' | 'saved'> {
  const blob = await drawTag(input);
  const file = new File([blob], `cds-pass-${(input.tag ?? 'tag').toLowerCase()}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'My CDS Pass tag', text: input.tag ? `My CDS number today: ${input.tag}` : 'My CDS Pass tag' });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  saveBlob(blob, file.name);
  return 'saved';
}

export async function saveTag(input: TagImageInput) {
  const blob = await drawTag(input);
  saveBlob(blob, `cds-pass-${(input.tag ?? 'tag').toLowerCase()}.png`);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
