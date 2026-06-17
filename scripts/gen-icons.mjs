// Generates the brand raster assets from the master serif design:
//   app/favicon.ico        — multi-size (16/32/48) legacy + bare /favicon.ico
//   app/apple-icon.png     — 180x180 full-bleed for iOS home screens
//   app/opengraph-image.png — 1200x630 social share card
//   app/twitter-image.png   — copy of the share card for Twitter/X
// The modern favicon is app/icon.svg (served directly by Next.js).
//
// Run with:  node scripts/gen-icons.mjs
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");

// rx = corner radius (0 = full-bleed square, for the iOS icon which iOS masks).
const monogram = (size, rx) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${rx}" fill="#000000"/>
  <text x="32" y="33" fill="#ffffff" font-family="Georgia, 'Times New Roman', Times, serif"
        font-size="42" font-weight="400" text-anchor="middle" dominant-baseline="central">N</text>
</svg>`;

const png = (size, rx) =>
  sharp(Buffer.from(monogram(size, rx))).png().toBuffer();

await mkdir(appDir, { recursive: true });

// favicon.ico — bundle a few sizes so it stays crisp in tabs and bookmarks.
const icoSizes = [16, 32, 48];
const icoPngs = await Promise.all(icoSizes.map((s) => png(s, 13)));
await writeFile(path.join(appDir, "favicon.ico"), await pngToIco(icoPngs));

// apple-icon.png — full-bleed (no rounded corners; iOS rounds it itself).
await writeFile(path.join(appDir, "apple-icon.png"), await png(180, 0));

// opengraph-image.png — 1200x630 social share card matching the site's
// black/white serif identity.
const ogCard = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#000000"/>
  <text x="600" y="300" fill="#ffffff" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', Times, serif" font-size="96" font-weight="400">
    Natalie R Nathan
  </text>
  <line x1="500" y1="356" x2="700" y2="356" stroke="#ffffff" stroke-width="1" opacity="0.5"/>
  <text x="600" y="412" fill="#cccccc" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', Times, serif" font-size="34"
        letter-spacing="6">FINE ARTIST · LOS ANGELES</text>
</svg>`;
const ogPath = path.join(appDir, "opengraph-image.png");
await writeFile(ogPath, await sharp(Buffer.from(ogCard)).png().toBuffer());
await copyFile(ogPath, path.join(appDir, "twitter-image.png"));

console.log(
  "Wrote app/favicon.ico, app/apple-icon.png, app/opengraph-image.png, app/twitter-image.png"
);
