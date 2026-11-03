// Timeline frames: the model's screenshot, shrunk here in Node. Chromium's own
// scaled capture (Page.captureScreenshot with clip.scale) leaves hit-testing in
// cross-site iframes out of step with the page afterwards, so a later click could
// land somewhere other than where the guard looked. It is deliberately not used.
import { decode, encode } from "jpeg-js";

/** A JPEG at most `width` pixels wide, averaged down from `jpeg`. */
export function thumbnail(jpeg: Buffer, width = 400, quality = 50): Buffer {
  const src = decode(jpeg, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40 });
  const scale = Math.min(1, width / src.width);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8Array(w * h * 4);
  // A box filter: each output pixel is the average of the source pixels it covers.
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / scale);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / scale);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return encode({ data: out, width: w, height: h }, quality).data;
}
