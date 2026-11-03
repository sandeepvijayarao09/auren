// JPEG helpers for camera frames: check the bytes, read the size without
// decoding, and cut the receipt crop. Frames arrive already blurred and
// stripped of metadata by the device; Core keeps only the crop.
import jpeg from "jpeg-js";

/** A box in frame pixels, as SAM 3.1 returns it. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Width and height from the frame header, without decoding the image. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isJpeg(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // markers with no length
      continue;
    }
    // SOF0 to SOF15 carry the size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return width && height ? { width, height } : null;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // the image ended or began with no frame header
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

/** Cuts `box` out of the frame and re-encodes it, at most `maxSide` pixels on its long side. */
export function cropJpeg(frame: Uint8Array, box: Box, maxSide = 640, quality = 80): Buffer {
  const img = jpeg.decode(frame, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 24, maxMemoryUsageInMB: 256 });
  const clamp = (v: number, hi: number) => Math.min(Math.max(Math.round(v), 0), hi);
  const x1 = clamp(Math.min(box.x1, box.x2), img.width - 1);
  const y1 = clamp(Math.min(box.y1, box.y2), img.height - 1);
  const w = Math.max(1, clamp(Math.max(box.x1, box.x2), img.width) - x1);
  const h = Math.max(1, clamp(Math.max(box.y1, box.y2), img.height) - y1);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const sy = y1 + Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < ow; x++) {
      const sx = x1 + Math.min(w - 1, Math.floor(x / scale));
      const from = (sy * img.width + sx) * 4;
      out.set(img.data.subarray(from, from + 4), (y * ow + x) * 4);
    }
  }
  return jpeg.encode({ width: ow, height: oh, data: out }, quality).data;
}
