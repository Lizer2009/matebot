/**
 * Emit the macOS/iOS Icon Composer artwork for Matebot from branding/matebot-icon.png.
 *
 * The source art is a rounded square on white, which is not what an `.icon` catalog
 * wants: Icon Composer composites layers over the icon's own squircle, so the art has
 * to be full-bleed. Rebuild the plate behind the art from the same indigo-to-teal
 * gradient the mark uses, then drop the art on top with its rounded corners masked out.
 *
 * Run: pnpm --filter @matebot/ui-tokens export:matebot-icon
 */
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));

const SIZE = 1024;
const source = path("branding/matebot-icon.png");
const target = path("packages/ui-tokens/assets/Matebot.icon/Assets/matebot-icon.png");

// Sampled from the mark's own corners so the rebuilt plate continues the art.
const START = { r: 58, g: 35, b: 141 };
const END = { r: 13, g: 171, b: 156 };

const plate = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="rgb(${START.r},${START.g},${START.b})"/>` +
    `<stop offset="1" stop-color="rgb(${END.r},${END.g},${END.b})"/>` +
    `</linearGradient></defs>` +
    `<rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/></svg>`,
);

// The art's own squircle, so its white outside becomes transparent instead of a plate.
const squircle = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="200" fill="white"/></svg>`,
);

const art = await sharp(source)
  .resize(SIZE, SIZE, { fit: "cover" })
  .composite([{ input: squircle, blend: "dest-in" }])
  .png()
  .toBuffer();

await sharp(plate)
  .composite([{ input: art }])
  .png()
  .toFile(target);

console.log(`Wrote ${target}`);
