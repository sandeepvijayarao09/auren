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

/**
 * Shrinks a frame to at most `maxSide` pixels on its long side for the models:
 * fewer image tokens for Spark and less upload for both. `scale` maps a box
 * from the small frame back to the full one (full = small * scale). A frame
 * already small enough comes back as is, with scale 1.
 */
export function downscaleJpeg(frame: Uint8Array, maxSide = 1024, quality = 85): { jpeg: Buffer; scale: number; width: number; height: number } {
  const size = jpegSize(frame);
  if (size && Math.max(size.width, size.height) <= maxSide) return { jpeg: Buffer.from(frame), scale: 1, ...size };
  const img = jpeg.decode(frame, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 24, maxMemoryUsageInMB: 256 });
  const k = maxSide / Math.max(img.width, img.height);
  if (k >= 1) return { jpeg: Buffer.from(frame), scale: 1, width: img.width, height: img.height };
  const ow = Math.max(1, Math.round(img.width * k));
  const oh = Math.max(1, Math.round(img.height * k));
  const out = Buffer.alloc(ow * oh * 4);
  // Box filter: average the source pixels under each output pixel, so text stays legible.
  const sx = img.width / ow;
  const sy = img.height / oh;
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * ow + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { jpeg: jpeg.encode({ width: ow, height: oh, data: out }, quality).data, scale: img.width / ow, width: ow, height: oh };
}

/** A box on a downscaled frame, back in full-frame pixels. */
export const scaleBox = (b: Box, scale: number): Box =>
  scale === 1 ? b : { x1: Math.round(b.x1 * scale), y1: Math.round(b.y1 * scale), x2: Math.round(b.x2 * scale), y2: Math.round(b.y2 * scale) };
