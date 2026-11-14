// Generates simple "no entry" (red disc + diagonal bar) PNG icons with no
// external dependencies. Run with: node tools/make-icons.mjs

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import zlib from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS = join(__dirname, "..", "icons");

function makePng(size) {
  const c = (size - 1) / 2;
  const r = size * 0.46;
  const ring = r * 0.82;          // inner edge of the red ring
  const barHalf = size * 0.09;    // half-thickness of the diagonal bar

  // Build RGBA pixel rows, each prefixed with a filter byte (0).
  const rowLen = size * 4;
  const raw = Buffer.alloc((rowLen + 1) * size);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowLen + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let red = 0, green = 0, blue = 0, alpha = 0;

      if (dist <= r) {
        // Diagonal bar (top-left to bottom-right) is white.
        const barDist = Math.abs(dx - dy) / Math.SQRT2;
        const onBar = barDist <= barHalf && dist <= ring + 1;
        if (dist > ring || onBar) {
          red = 255; green = 255; blue = 255; alpha = 255; // ring + bar white
        } else {
          red = 200; green = 40; blue = 40; alpha = 255;   // red disc
        }
      }
      const i = rowStart + 1 + x * 4;
      raw[i] = red; raw[i + 1] = green; raw[i + 2] = blue; raw[i + 3] = alpha;
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  // 10,11,12 = compression/filter/interlace = 0

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(ICONS, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(join(ICONS, `icon${size}.png`), makePng(size));
  console.log(`wrote icons/icon${size}.png`);
}
