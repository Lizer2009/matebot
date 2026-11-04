/**
 * Export Matebot favicons from branding/matebot-icon-source.jpg (Matebot fork).
 * Run: pnpm --filter @rakazo/ui-tokens export:matebot
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));

const iconSource = path("branding/matebot-icon-source.jpg");
const wordmarkSource = path("branding/matebot-wordmark-source.jpg");

const mask = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="200" fill="white"/></svg>',
);

async function roundedSquare(input: Buffer) {
  return sharp(input)
    .resize(1024, 1024, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function png(input: Buffer, name: string, size: number) {
  await sharp(input).resize(size, size).png().toFile(path(name));
}

async function ico(input: Buffer, name: string, sizes: number[]) {
  const frames = await Promise.all(sizes.map((size) => sharp(input).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(path(name), Buffer.concat([header, ...frames]));
}

const square = await sharp(iconSource).resize(1024, 1024, { fit: "cover" }).png().toBuffer();
const rounded = await roundedSquare(square);

await mkdir(path("docs/assets"), { recursive: true });

await sharp(square).png().toFile(path("branding/matebot-icon.png"));
await sharp(wordmarkSource).png().toFile(path("branding/matebot-wordmark.png"));
await copyFile(path("branding/matebot-icon.png"), path("docs/assets/matebot-icon.png"));
await copyFile(path("branding/matebot-wordmark.png"), path("docs/assets/matebot-wordmark.png"));

for (const app of ["web"]) {
  const publicDir = `apps/${app}/public`;
  await png(rounded, `${publicDir}/favicon-16x16.png`, 16);
  await png(rounded, `${publicDir}/favicon-32x32.png`, 32);
  await png(rounded, `${publicDir}/favicon.png`, 128);
  await png(square, `${publicDir}/apple-touch-icon.png`, 180);
  await png(square, `${publicDir}/icon-192.png`, 192);
  await png(square, `${publicDir}/icon-512.png`, 512);
  await png(square, `${publicDir}/matebot-icon.png`, 512);
  await sharp(wordmarkSource)
    .resize(1200, null, { fit: "inside" })
    .png()
    .toFile(path(`${publicDir}/matebot-wordmark.png`));
  await ico(rounded, `${publicDir}/favicon.ico`, [16, 32, 48]);
}

await png(rounded, "apps/mobile/assets/favicon.png", 128);
await png(square, "apps/desktop/assets/icon.png", 1024);
await ico(rounded, "apps/desktop/assets/icon.ico", [16, 32, 48, 64, 128, 256]);

console.log("Matebot icons exported.");
