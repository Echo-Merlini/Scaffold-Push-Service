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

export async function processLogo(buffer: Buffer): Promise<{
  logo: string;     // 192×192 — notification icon
  logo512: string;  // 512×512 — PWA app icon
  logoBadge: string; // 96×96  — Android badge
}> {
  validateImageSize(buffer.length);
  const [logo, logo512, logoBadge] = await Promise.all([
    resizeToDataUrl(buffer, 192),
    resizeToDataUrl(buffer, 512),
    resizeToDataUrl(buffer, 96),
  ]);
  return { logo, logo512, logoBadge };
}
