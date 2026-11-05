/**
 * Build the marketing site's wordmark SVG from branding/matebot-wordmark.png.
 *
 * The source art is a flat-colour raster export: two ink colours on white. A strict
 * ink mask discards anti-aliased colour blending, then the outlines are traced and
 * simplified so the exported SVG is a handful of clean polygons instead of a
 * pixel staircase. Run after changing the art:
 *
 *   pnpm --filter @matebot/ui-tokens export:matebot-wordmark
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/** Pixels closer than this to white are anti-aliasing, not ink. */
const INK_DISTANCE = 96;
/** Trace at 2x so a diagonal edge lands within half a source pixel. */
const UPSCALE = 2;
const SIMPLIFY_TOLERANCE = 0.9;

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));
const SOURCE = path("branding/matebot-wordmark.png");
const TARGET = path("apps/www/public/brand/kit/matebot-wordmark.svg");

const INDIGO = "#312E81";
const TEAL = "#0D9488";

type Point = [number, number];

type Sample = { ink: boolean; indigo: boolean };

function classify(r: number, g: number, b: number): Sample {
  const distance = Math.hypot(255 - r, 255 - g, 255 - b);
  if (distance < INK_DISTANCE) return { ink: false, indigo: false };
  // Indigo leans blue and dark; the teal accent is the other ink in the art.
  return { ink: true, indigo: b > r + 30 && b > g + 10 };
}

/** Rasterise the art and classify every pixel once. */
async function readArt() {
  const { data, info } = await sharp(SOURCE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const samples = new Uint8Array(info.width * info.height);
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const sample = classify(data[i]!, data[i + 1]!, data[i + 2]!);
      samples[y * info.width + x] = sample.ink ? (sample.indigo ? 1 : 2) : 0;
      if (sample.ink) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { data, info, samples, box: { minX, minY, maxX, maxY } };
}

/** Is a pixel part of `color`'s region? Neighbour lookups outside the art are empty. */
function region(samples: Uint8Array, width: number, height: number, color: 1 | 2 | 3) {
  return (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const value = samples[y * width + x]!;
    return color === 3 ? value !== 0 : value === color;
  };
}

/**
 * Trace the boundary of a binary region as closed polygons, walking each boundary
 * so that the region stays on the left. Every pixel contributes its exposed edges,
 * which yields exact corners for rectilinear and diagonal edges alike.
 */
function trace(
  inside: (x: number, y: number) => boolean,
  width: number,
  height: number,
): Point[][] {
  const key = (x: number, y: number) => `${x},${y}`;
  const outgoing = new Map<string, Point>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) outgoing.set(key(x, y), [x + 1, y]);
      if (!inside(x + 1, y)) outgoing.set(key(x + 1, y), [x + 1, y + 1]);
      if (!inside(x, y + 1)) outgoing.set(key(x + 1, y + 1), [x, y + 1]);
      if (!inside(x - 1, y)) outgoing.set(key(x, y + 1), [x, y]);
    }
  }

  const polygons: Point[][] = [];
  while (outgoing.size > 0) {
    const [startKey, step] = outgoing.entries().next().value as [string, Point];
    const start = startKey.split(",").map(Number) as Point;
    const polygon: Point[] = [start];
    outgoing.delete(startKey);
    let current: Point = step;
    while (outgoing.has(key(current[0], current[1]))) {
      polygon.push(current);
      const next = outgoing.get(key(current[0], current[1]))!;
      outgoing.delete(key(current[0], current[1]));
      current = next;
    }
    if (polygon.length > 2) polygons.push(polygon);
  }
  return polygons;
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  if (length === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer–Douglas–Peucker over a closed run of points. */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = distanceToSegment(points[i]!, points[0]!, points[points.length - 1]!);
    if (distance > worst) {
      worst = distance;
      index = i;
    }
  }
  if (worst <= tolerance) return [points[0]!, points[points.length - 1]!];
  const head = simplify(points.slice(0, index + 1), tolerance);
  const tail = simplify(points.slice(index), tolerance);
  return [...head.slice(0, -1), ...tail];
}

function outline(polygons: Point[][], scale: number) {
  const round = (value: number) => Math.round(value * 100) / 100;
  return polygons
    .map((polygon) => {
      // Split at the corner farthest from the start so the closed path simplifies as an arc.
      let far = 1;
      let farDistance = 0;
      for (let i = 1; i < polygon.length; i++) {
        const distance = Math.hypot(
          polygon[i]![0] - polygon[0]![0],
          polygon[i]![1] - polygon[0]![1],
        );
        if (distance > farDistance) {
          farDistance = distance;
          far = i;
        }
      }
      const simplified = [
        ...simplify(polygon.slice(0, far + 1), SIMPLIFY_TOLERANCE),
        ...simplify([...polygon.slice(far), polygon[0]!], SIMPLIFY_TOLERANCE).slice(1),
      ];
      // The raster trace and SVG both count Y downward, so the coordinates carry over as-is.
      const points = simplified.map(([x, y]) => `${round(x * scale)},${round(y * scale)}`);
      return `M${points.join("L")}Z`;
    })
    .join("");
}

const art = await readArt();
const width = (art.box.maxX - art.box.minX + 1) * UPSCALE;
const height = (art.box.maxY - art.box.minY + 1) * UPSCALE;

const scaled = await sharp(art.data, {
  raw: { width: art.info.width, height: art.info.height, channels: art.info.channels },
})
  .extract({
    left: art.box.minX,
    top: art.box.minY,
    width: art.box.maxX - art.box.minX + 1,
    height: art.box.maxY - art.box.minY + 1,
  })
  .resize(width, height, { kernel: "nearest" })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const samples = new Uint8Array(width * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * scaled.info.channels;
    const sample = classify(scaled.data[i]!, scaled.data[i + 1]!, scaled.data[i + 2]!);
    samples[y * width + x] = sample.ink ? (sample.indigo ? 1 : 2) : 0;
  }
}

const scale = 1 / UPSCALE;
const paths = [
  { color: INDIGO, d: outline(trace(region(samples, width, height, 1), width, height), scale) },
  { color: TEAL, d: outline(trace(region(samples, width, height, 2), width, height), scale) },
];

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(width * scale)} ${Math.round(height * scale)}" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}">`,
  `<title>Matebot</title>`,
  ...paths.map(({ color, d }) => `<path fill="${color}" fill-rule="evenodd" d="${d}"/>`),
  `</svg>`,
  "",
].join("\n");

await writeFile(TARGET, svg);
await readFile(TARGET);
console.log(`Wrote the wordmark at ${Math.round(width * scale)}×${Math.round(height * scale)}.`);
