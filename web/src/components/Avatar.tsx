export function Avatar({ src, name, size = 48, ring = false }: { src?: string | null; name: string; size?: number; ring?: boolean }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-full bg-green-light ${ring ? 'ring-4 ring-white shadow-lift' : ''}`}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt={name} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="grid h-full w-full place-items-center font-extrabold text-green" style={{ fontSize: size * 0.36 }}>
          {initials}
        </div>
      )}
    </div>
  );
}
