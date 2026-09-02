import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = path.join(root, "app", "icon.svg");
const faviconPath = path.join(root, "app", "favicon.ico");
const appleIconPath = path.join(root, "app", "apple-icon.png");

const faviconPng = await sharp(source).resize(64, 64).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt8(64, 6);
header.writeUInt8(64, 7);
header.writeUInt8(0, 8);
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(faviconPng.length, 14);
header.writeUInt32LE(22, 18);

await fs.writeFile(faviconPath, Buffer.concat([header, faviconPng]));
await sharp(source).resize(180, 180).png().toFile(appleIconPath);

console.log("Generated app/favicon.ico and app/apple-icon.png from app/icon.svg");
