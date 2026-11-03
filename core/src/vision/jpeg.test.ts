import assert from "node:assert/strict";
import { test } from "node:test";
import jpeg from "jpeg-js";
import { cropJpeg, isJpeg, jpegSize } from "./jpeg.ts";
import { posterJpeg } from "./test-frames.ts";

test("reads a JPEG's size from its header and rejects other bytes", () => {
  const frame = posterJpeg(96, 64);
  assert.equal(isJpeg(frame), true);
  assert.deepEqual(jpegSize(frame), { width: 96, height: 64 });
  assert.equal(isJpeg(Buffer.from("\x89PNG\r\n\x1a\n")), false);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});

test("the crop is just the box, scaled down, and decodes as a JPEG", () => {
  const crop = cropJpeg(posterJpeg(960, 640), { x1: 320, y1: 160, x2: 640, y2: 480 }, 160);
  assert.deepEqual(jpegSize(crop), { width: 160, height: 160 });
  const px = jpeg.decode(crop, { useTArray: true });
  // The middle of the crop is poster, not wall.
  const i = (80 * 160 + 80) * 4;
  assert.ok(px.data[i] > 200 && px.data[i + 2] < 120, `poster colour, got ${px.data.subarray(i, i + 3)}`);
});

test("a box that runs off the frame is clamped to it", () => {
  const crop = cropJpeg(posterJpeg(96, 64), { x1: -40, y1: 50, x2: 500, y2: 900 });
  assert.deepEqual(jpegSize(crop), { width: 96, height: 14 });
});
