/**
 * Shrinks a photo in the browser so it uploads small (at most `maxBytes`, default 2 MB), using only the browser's own
 * image decoding and <canvas> — nothing leaves the page and no outside service or library is used.
 *
 * A photo already within the limit is uploaded as it is. A larger one is redrawn at most 2560 px on its longest side
 * and saved as JPEG, lowering the quality step by step, then the size, until it fits. Transparent areas become white.
 */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 2560;

export interface ShrinkResult {
  file: File;
  /** True when the photo was made smaller. */
  shrunk: boolean;
  originalBytes: number;
}

export async function shrinkImage(file: File, maxBytes = MAX_PHOTO_BYTES): Promise<ShrinkResult> {
  if (file.size <= maxBytes) return { file, shrunk: false, originalBytes: file.size };
  if (file.type === 'image/gif') {
    throw new Error(`${file.name} is ${mb(file.size)}: animated GIFs cannot be made smaller here. Use a GIF of at most ${mb(maxBytes)} or a JPEG/PNG photo.`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`${file.name} could not be opened in this browser to make it smaller. Save it as JPEG or PNG and try again.`);
  }

  try {
    let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    for (let round = 0; round < 8; round++) {
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('This browser cannot resize images.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      for (const quality of [0.88, 0.8, 0.72, 0.64]) {
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
        if (blob && blob.size <= maxBytes) {
          const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          return { file: new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified }), shrunk: true, originalBytes: file.size };
        }
      }
      scale *= 0.8;
    }
    throw new Error(`${file.name} could not be made smaller than ${mb(maxBytes)}.`);
  } finally {
    bitmap.close();
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
