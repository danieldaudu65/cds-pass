/**
 * Crops a photo to a centred square and shrinks it to ~512px JPEG,
 * so a profile picture costs ~40–80 KB of data instead of several MB.
 *
 * Phone cameras take 12–50 megapixel photos. Opening one at full size needs 50–200 MB of memory,
 * which can make a low-memory phone close the app. So we ask the browser to decode it already
 * shrunk (createImageBitmap with resize), and only fall back to the full-size way if that isn't supported.
 */
export async function compressPhoto(file: File, size = 512, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith('image/') && file.type !== '') throw new Error('Please choose a photo.');

  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let cleanup = () => {};

  try {
    // Decode at about 2× the final size; keeps the shape, uses a fraction of the memory.
    const bmp = await createImageBitmap(file, { resizeWidth: size * 2, resizeQuality: 'high', imageOrientation: 'from-image' });
    source = bmp;
    width = bmp.width;
    height = bmp.height;
    cleanup = () => bmp.close();
  } catch {
    const url = URL.createObjectURL(file);
    cleanup = () => URL.revokeObjectURL(url);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that photo. Try another one.'));
      i.src = url;
    }).catch((e) => {
      cleanup();
      throw e;
    });
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
  }

  try {
    const side = Math.min(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot process photos.');
    ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process photo.'))), 'image/jpeg', quality),
    );
  } finally {
    cleanup();
  }
}
