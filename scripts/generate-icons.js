// Generate the app icon from the official dsh whale favicon.
// 1. Freeze the official SVG into build/icon.svg (survives dsh updates).
// 2. Rasterize with sharp: gray whale (#9AA0A6) on transparent background.
//    - build/icon.png  (1024x1024, electron-builder converts to .ico automatically)
//    - renderer/icon.png (256x256, used for window/tray/loading favicon; packaged too)
// Usage: node scripts/generate-icons.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const OFFICIAL = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg');
const FROZEN = path.join(ROOT, 'build', 'icon.svg');
const BUILD_PNG = path.join(ROOT, 'build', 'icon.png');
const RENDERER_PNG = path.join(ROOT, 'renderer', 'icon.png');

async function main() {
  if (!fs.existsSync(OFFICIAL)) {
    console.error('[generate-icons] official favicon.svg not found: ' + OFFICIAL);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(FROZEN), { recursive: true });
  let svg = fs.readFileSync(OFFICIAL, 'utf8');
  // The official SVG colors via a prefers-color-scheme media query (white in dark).
  // For an app icon we need a fixed color: gray whale as requested.
  svg = svg.replace(/<style>[\s\S]*?<\/style>/, '');
  // Original light-mode fill is #000; the whale is shown gray in the app, so use gray.
  svg = svg.replace(/fill="#000"/, 'fill="#9AA0A6"');
  fs.writeFileSync(FROZEN, svg, 'utf8');

  const buf = Buffer.from(svg, 'utf8');
  await sharp(buf).resize(1024, 1024).png().toFile(BUILD_PNG);
  await sharp(buf).resize(256, 256).png().toFile(RENDERER_PNG);
  console.log('[generate-icons] wrote build/icon.svg, build/icon.png (1024), renderer/icon.png (256)');
}

main().catch((err) => { console.error(err); process.exit(1); });
