// Synthetic camera frames for the vision tests.
import jpeg from "jpeg-js";

/** A synthetic frame: a dark wall with a bright poster in the middle third. */
export function posterJpeg(width = 96, height = 64): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onPoster = x >= width / 3 && x < (2 * width) / 3 && y >= height / 4 && y < (3 * height) / 4;
      data.set(onPoster ? [240, 200, 80, 255] : [20, 20, 30, 255], (y * width + x) * 4);
    }
  }
  return jpeg.encode({ width, height, data }, 90).data;
}
