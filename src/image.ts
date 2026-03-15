import sharp from "sharp";

const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5MB input limit

export function validateImageSize(bytes: number) {
  if (bytes > MAX_INPUT_BYTES) {
    throw new Error("Image must be under 5MB");
  }
}

async function resizeToDataUrl(buffer: Buffer, size: number): Promise<string> {
  const resized = await sharp(buffer)
    .resize(size, size, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  return `data:image/png;base64,${resized.toString("base64")}`;
}

/** Build a multi-resolution .ico file embedding 16, 32, and 48 px PNGs. */
async function buildIco(buffer: Buffer): Promise<Buffer> {
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(
    sizes.map(s =>
      sharp(buffer).resize(s, s, { fit: "cover", position: "centre" }).png().toBuffer()
    )
  );

  // ICONDIR header (6 bytes)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type = 1 (ICO)
  header.writeUInt16LE(sizes.length, 4); // image count

  // ICONDIRENTRY (16 bytes each) — offset starts after header + all entries
  let dataOffset = 6 + 16 * sizes.length;
  const entries = pngs.map((png, i) => {
    const sz = sizes[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sz, 0);             // width  (0 = 256)
    entry.writeUInt8(sz, 1);             // height (0 = 256)
    entry.writeUInt8(0, 2);              // color count (0 = true color)
    entry.writeUInt8(0, 3);              // reserved
    entry.writeUInt16LE(1, 4);           // planes
    entry.writeUInt16LE(32, 6);          // bit count
    entry.writeUInt32LE(png.length, 8);  // bytes of image data
    entry.writeUInt32LE(dataOffset, 12); // offset to image data
    dataOffset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...pngs]);
}

export async function processLogo(buffer: Buffer): Promise<{
  logo: string;      // 192×192 PNG — notification icon
  logo512: string;   // 512×512 PNG — PWA app icon
  logoBadge: string; //  96×96  PNG — Android badge
  logoIco: string;   // multi-res .ico (16/32/48) — favicon
}> {
  validateImageSize(buffer.length);
  const [logo, logo512, logoBadge, icoBuffer] = await Promise.all([
    resizeToDataUrl(buffer, 192),
    resizeToDataUrl(buffer, 512),
    resizeToDataUrl(buffer, 96),
    buildIco(buffer),
  ]);
  const logoIco = `data:image/x-icon;base64,${icoBuffer.toString("base64")}`;
  return { logo, logo512, logoBadge, logoIco };
}
