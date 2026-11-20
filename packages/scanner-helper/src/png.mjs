// PNG header reading (no decoding): width and height from the IHDR chunk.
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** { width, height } of a PNG, or null if the bytes are not a PNG with a valid IHDR first chunk. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return null;
  const type = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
  if (type !== "IHDR") return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
