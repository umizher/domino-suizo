/* Genera icons/icon-192.png e icons/icon-512.png sin dependencias.
 * Encoder PNG mínimo (RGBA, filtro 0) usando zlib de node.
 * Dibujo: ficha de dominó (3|2) sobre fondo azul oscuro con borde redondeado.
 * Ejecutar: node scripts/make-icons.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* ---------- PNG encoder ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filtro: ninguno
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------- dibujo ---------- */
function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const inRoundRect = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
    const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad ||
           (x >= x0 + rad && x <= x1 - rad) || (y >= y0 + rad && y <= y1 - rad);
  };
  const inCircle = (x, y, cx, cy, rad) => (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;

  const s = size;
  // ficha vertical centrada
  const tw = s * 0.46, th = s * 0.74;
  const tx0 = (s - tw) / 2, ty0 = (s - th) / 2, tx1 = tx0 + tw, ty1 = ty0 + th;
  const tileRad = s * 0.06;
  const midY = (ty0 + ty1) / 2;
  const dotR = s * 0.045;
  // pips: 3 arriba (diagonal), 2 abajo (diagonal)
  const inset = tw * 0.24;
  const topC = (ty0 + midY) / 2, botC = (midY + ty1) / 2;
  const dots = [
    [tx0 + inset, topC - th * 0.11], [tx0 + tw / 2, topC], [tx1 - inset, topC + th * 0.11],
    [tx0 + inset, botC + th * 0.11], [tx1 - inset, botC - th * 0.11]
  ];

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // fondo: azul oscuro con esquina redondeada suave (maskable-friendly)
      if (!inRoundRect(x, y, 0, 0, s - 1, s - 1, s * 0.18)) { put(x, y, 0, 0, 0, 0); continue; }
      // degradado vertical sutil
      const t = y / s;
      let r = Math.round(11 + 10 * t), g = Math.round(18 + 14 * t), b = Math.round(32 + 30 * t);
      put(x, y, r, g, b);
      // ficha
      if (inRoundRect(x, y, tx0, ty0, tx1, ty1, tileRad)) {
        put(x, y, 238, 242, 252);
        // línea divisoria
        if (Math.abs(y - midY) <= s * 0.008) put(x, y, 34, 48, 79);
        // pips
        for (const [dx, dy] of dots)
          if (inCircle(x, y, dx, dy, dotR)) put(x, y, 24, 36, 64);
      }
    }
  }
  return encodePNG(s, px);
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log(`OK ${file}`);
}
