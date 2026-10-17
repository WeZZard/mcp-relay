import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * How a saved original becomes the typed image block an agent runtime sees.
 * Every bound is a fact the receipt carries beside the untouched original. pi
 * presents through its own resize helper; this core has no host library, so a
 * PNG original that exceeds the preview bounds is resampled here in-process
 * (node:zlib only), while JPEG and WebP originals pass through unchanged when
 * they fit and are reported presentation-unavailable when they do not.
 */
export const IMAGE_PRESENTATION_POLICY = Object.freeze({
 version: 1,
 processor: 'mcp-relay/image-presentation',
 maxWidth: 2000,
 maxHeight: 2000,
 maxBytes: 4 * 1024 * 1024,
 maxBytesEncoding: 'base64',
 maxOriginalBytes: 64 * 1024 * 1024,
 maxPixels: 40_000_000,
 maxDimension: 32768,
 supportedMimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
 /** Formats resampled in-process when they exceed the preview bounds; the others pass through or are unavailable. */
 resampledMimeTypes: Object.freeze(['image/png']),
 animation: 'reject',
 /** iCCP, zTXt and iTXt (macOS captures carry a color profile and XMP) are checksum-verified, never inflated, and dropped from a resampled preview. */
 compressedPngMetadata: 'ignore',
 jpegFrames: Object.freeze(['baseline', 'progressive']),
 maxContainerRecords: 10000,
 /** Dimensions are those stored in the container; no EXIF orientation is applied. */
 dimensionSpace: 'stored',
} as const);

export class PresentationUnavailableError extends Error {
 readonly code = 'presentation-unavailable';
 constructor(message: string, options?: ErrorOptions) {
  super(message, options);
  this.name = 'PresentationUnavailableError';
 }
}

export interface PreparedImage {
 content: { type: 'image'; data: string; mimeType: string };
 presentation: {
  originalWidth: number; originalHeight: number; width: number; height: number;
  mimeType: string; sha256: string; bytes: number; transformed: boolean;
  policy: typeof IMAGE_PRESENTATION_POLICY;
 };
}

type Dimensions = { width: number; height: number };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_RECORDS = IMAGE_PRESENTATION_POLICY.maxContainerRecords;
function requireImage(condition: unknown, message: string): asserts condition {
 if (!condition) throw new PresentationUnavailableError(message);
}
function dimensions(width: number, height: number): Dimensions {
 const p = IMAGE_PRESENTATION_POLICY;
 requireImage(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0,
  'Invalid image dimensions');
 requireImage(width <= p.maxDimension && height <= p.maxDimension && width * height <= p.maxPixels,
  'Image exceeds decode dimension or pixel limits');
 return { width, height };
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
 for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
 return value >>> 0;
});
function crc32(bytes: Buffer): number {
 let value = 0xffffffff;
 for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
 return (value ^ 0xffffffff) >>> 0;
}
function pngDimensions(bytes: Buffer): Dimensions {
 requireImage(bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'Invalid PNG signature or header');
 requireImage(bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'Invalid PNG IHDR');
 const size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
 const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
 requireImage(depths[bytes[25]]?.includes(bytes[24]) && bytes[26] === 0 && bytes[27] === 0 && bytes[28] <= 1,
  'Unsupported PNG header');
 let offset = 8, records = 0, data = false, dataEnded = false;
 while (offset < bytes.length) {
  requireImage(++records <= MAX_RECORDS && offset + 12 <= bytes.length, 'Invalid PNG chunk structure');
  const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
  requireImage(end <= bytes.length, 'Truncated PNG chunk');
  const type = bytes.toString('ascii', offset + 4, offset + 8);
  requireImage(/^[A-Za-z]{4}$/.test(type), 'Invalid PNG chunk type');
  requireImage(!['acTL', 'fcTL', 'fdAT'].includes(type), 'Animated PNG is unsupported');
  requireImage(type !== 'IHDR' || offset === 8, 'Duplicate PNG header');
  requireImage(type[0] !== type[0].toUpperCase() || ['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type),
   'Unsupported critical PNG chunk');
  requireImage(crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4), 'Invalid PNG checksum');
  if (type === 'IDAT') {
   requireImage(!dataEnded, 'Nonconsecutive PNG image data');
   data = true;
  } else if (data) dataEnded = true;
  if (type === 'IEND') {
   requireImage(length === 0 && data && end === bytes.length, 'Invalid PNG end');
   return size;
  }
  offset = end;
 }
 throw new PresentationUnavailableError('Missing PNG end');
}
function jpegDimensions(bytes: Buffer): Dimensions {
 requireImage(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8, 'Invalid JPEG signature');
 let offset = 2, records = 0, size: Dimensions | undefined, scanned = false;
 while (offset < bytes.length) {
  requireImage(++records <= MAX_RECORDS && bytes[offset++] === 0xff, 'Invalid JPEG marker');
  while (offset < bytes.length && bytes[offset] === 0xff) offset++;
  requireImage(offset < bytes.length, 'Truncated JPEG marker');
  const marker = bytes[offset++];
  if (marker === 0xd9) {
   requireImage(size && scanned && offset === bytes.length, 'Invalid JPEG end');
   return size;
  }
  requireImage(marker !== 0 && marker !== 0xd8 && marker !== 0xdc && !(marker >= 0xd0 && marker <= 0xd7),
   'Unsupported JPEG marker or deferred dimensions');
  requireImage(offset + 2 <= bytes.length, 'Truncated JPEG segment');
  const length = bytes.readUInt16BE(offset), end = offset + length;
  requireImage(length >= 2 && end <= bytes.length, 'Invalid JPEG segment length');
  if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
   requireImage((marker === 0xc0 || marker === 0xc2) && !size && length >= 8, 'Unsupported or duplicate JPEG frame');
   requireImage(bytes[offset + 2] === 8 && [1, 3, 4].includes(bytes[offset + 7]) && length === 8 + 3 * bytes[offset + 7],
    'Invalid JPEG frame header');
   size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
  }
  offset = end;
  if (marker === 0xda) {
   requireImage(size && length >= 6, 'JPEG scan before frame header');
   scanned = true;
   // Skip entropy-coded data, but inspect every subsequent frame/scan marker.
   while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const next = bytes[offset + 1];
    if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
    break;
   }
  }
 }
 throw new PresentationUnavailableError('Missing JPEG end');
}
function webpDimensions(bytes: Buffer): Dimensions {
 requireImage(bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
  'Invalid WebP signature');
 requireImage(bytes.readUInt32LE(4) + 8 === bytes.length, 'Invalid WebP RIFF length');
 let offset = 12, records = 0, canvas: Dimensions | undefined, image: Dimensions | undefined;
 while (offset < bytes.length) {
  requireImage(++records <= MAX_RECORDS && offset + 8 <= bytes.length, 'Invalid WebP chunk');
  const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
  const start = offset + 8, end = start + length;
  requireImage(end + (length & 1) <= bytes.length, 'Truncated WebP chunk');
  requireImage(type !== 'ANIM' && type !== 'ANMF', 'Animated WebP is unsupported');
  if (type === 'VP8X') {
   requireImage(offset === 12 && !canvas && length === 10 && (bytes[start] & 0xc3) === 0 &&
    bytes[start + 1] === 0 && bytes[start + 2] === 0 && bytes[start + 3] === 0, 'Invalid or animated WebP extended header');
   canvas = dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3));
  } else if (type === 'VP8 ') {
   requireImage(!image && length >= 10 && (bytes[start] & 1) === 0 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a])),
    'Invalid WebP VP8 frame');
   image = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
  } else if (type === 'VP8L') {
   requireImage(!image && length >= 5 && bytes[start] === 0x2f && (bytes[start + 4] & 0xe0) === 0, 'Invalid WebP lossless frame');
   const bits = bytes.readUInt32LE(start + 1);
   image = dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  offset = end + (length & 1);
 }
 requireImage(image && (!canvas || (canvas.width === image.width && canvas.height === image.height)), 'Missing or inconsistent WebP dimensions');
 return image;
}
function inspect(bytes: Buffer, mimeType: string): Dimensions {
 switch (mimeType) {
  case 'image/png': return pngDimensions(bytes);
  case 'image/jpeg': return jpegDimensions(bytes);
  case 'image/webp': return webpDimensions(bytes);
  default: throw new PresentationUnavailableError('Unsupported image MIME type; only PNG, JPEG, and WebP are accepted');
 }
}

/** An 8-bit straight-alpha RGBA raster: the one form every supported PNG decodes to and the preview encodes from. */
interface Raster { width: number; height: number; rgba: Uint8Array }

/** Decode a validated, non-interlaced PNG to RGBA8. Every colour type and bit depth the header check admits is handled. */
function decodePng(bytes: Buffer, size: Dimensions): Raster {
 const depth = bytes[24], colorType = bytes[25];
 requireImage(bytes[28] === 0, 'Interlaced PNG cannot be resampled here');
 const idat: Buffer[] = []; let plte: Buffer | undefined, trns: Buffer | undefined;
 for (let offset = 8; offset < bytes.length;) {
  const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), chunk = bytes.subarray(offset + 8, offset + 8 + length);
  if (type === 'IDAT') idat.push(chunk); else if (type === 'PLTE') plte = chunk; else if (type === 'tRNS') trns = chunk;
  if (type === 'IEND') break;
  offset += 12 + length;
 }
 const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
 requireImage(channels !== undefined, 'Unsupported PNG colour type');
 requireImage(colorType !== 3 || (plte && plte.length % 3 === 0 && plte.length > 0), 'Palette PNG lacks its palette');
 const { width, height } = size;
 const bitsPerPixel = channels * depth, bpp = Math.max(1, bitsPerPixel >> 3), stride = Math.ceil(width * bitsPerPixel / 8);
 let raw: Buffer;
 try { raw = inflateSync(Buffer.concat(idat)); } catch (cause) { throw new PresentationUnavailableError('PNG image data could not be decoded', { cause }); }
 requireImage(raw.length === (stride + 1) * height, 'PNG image data could not be decoded: its length does not match the header');
 const scan = new Uint8Array(stride * height);
 for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)], input = y * (stride + 1) + 1, out = y * stride, prev = out - stride;
  requireImage(filter <= 4, 'Invalid PNG filter type');
  for (let i = 0; i < stride; i++) {
   const x = raw[input + i], a = i >= bpp ? scan[out + i - bpp] : 0, b = y > 0 ? scan[prev + i] : 0, c = y > 0 && i >= bpp ? scan[prev + i - bpp] : 0;
   let value: number;
   if (filter === 0) value = x;
   else if (filter === 1) value = x + a;
   else if (filter === 2) value = x + b;
   else if (filter === 3) value = x + ((a + b) >> 1);
   else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
   scan[out + i] = value & 255;
  }
 }
 const rgba = new Uint8Array(width * height * 4);
 const max = (1 << depth) - 1;
 // A sample at (row, index) in the row's channel stream, scaled to 8 bits; 16-bit samples keep their high byte.
 const sample = (row: number, index: number): number => {
  if (depth === 8) return scan[row * stride + index];
  if (depth === 16) return scan[row * stride + index * 2];
  const bit = index * depth, byte = scan[row * stride + (bit >> 3)];
  return (byte >> (8 - depth - (bit & 7))) & max;
 };
 const rawSample = (row: number, index: number): number => depth === 16 ? (scan[row * stride + index * 2] << 8) | scan[row * stride + index * 2 + 1] : sample(row, index);
 const scale = depth < 8 ? 255 / max : 1;
 const key = trns && (colorType === 0 || colorType === 2) ? Array.from({ length: channels }, (_, i) => trns!.readUInt16BE(i * 2)) : undefined;
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const o = (y * width + x) * 4, i = x * channels;
  if (colorType === 3) {
   const index = sample(y, x) * 3;
   requireImage(index + 2 < plte!.length, 'Palette PNG index out of range');
   rgba[o] = plte![index]; rgba[o + 1] = plte![index + 1]; rgba[o + 2] = plte![index + 2];
   rgba[o + 3] = trns && sample(y, x) < trns.length ? trns[sample(y, x)] : 255;
   continue;
  }
  const keyed = key !== undefined && key.every((value, c) => rawSample(y, i + c) === value);
  if (colorType === 0 || colorType === 4) {
   const g = Math.round(sample(y, i) * scale);
   rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = colorType === 4 ? sample(y, i + 1) : keyed ? 0 : 255;
  } else {
   rgba[o] = sample(y, i); rgba[o + 1] = sample(y, i + 1); rgba[o + 2] = sample(y, i + 2); rgba[o + 3] = colorType === 6 ? sample(y, i + 3) : keyed ? 0 : 255;
  }
 }
 return { width, height, rgba };
}

/** Area-averaging downscale, separable. Every source pixel contributes to the destination in proportion to its coverage. */
function resample(source: Raster, width: number, height: number): Raster {
 if (width === source.width && height === source.height) return source;
 const spans = (from: number, to: number): Array<Array<[number, number]>> => {
  const result: Array<Array<[number, number]>> = [];
  for (let d = 0; d < to; d++) {
   const start = d * from / to, end = (d + 1) * from / to, weights: Array<[number, number]> = [];
   for (let s = Math.floor(start); s < Math.min(from, Math.ceil(end)); s++) {
    const overlap = Math.min(end, s + 1) - Math.max(start, s);
    if (overlap > 0) weights.push([s, overlap * to / from]);
   }
   result.push(weights);
  }
  return result;
 };
 const columns = spans(source.width, width), rows = spans(source.height, height);
 // Horizontal pass keeps full precision per row; the vertical pass reads it back.
 const horizontal = new Float32Array(width * source.height * 4);
 for (let y = 0; y < source.height; y++) for (let x = 0; x < width; x++) {
  const o = (y * width + x) * 4;
  for (const [s, w] of columns[x]) {
   const i = (y * source.width + s) * 4;
   horizontal[o] += source.rgba[i] * w; horizontal[o + 1] += source.rgba[i + 1] * w; horizontal[o + 2] += source.rgba[i + 2] * w; horizontal[o + 3] += source.rgba[i + 3] * w;
  }
 }
 const rgba = new Uint8Array(width * height * 4);
 const accumulator = new Float32Array(width * 4);
 for (let y = 0; y < height; y++) {
  accumulator.fill(0);
  for (const [s, w] of rows[y]) for (let i = 0; i < width * 4; i++) accumulator[i] += horizontal[s * width * 4 + i] * w;
  for (let i = 0; i < width * 4; i++) rgba[y * width * 4 + i] = Math.max(0, Math.min(255, Math.round(accumulator[i])));
 }
 return { width, height, rgba };
}

/** Encode RGBA8 as a minimal PNG: RGB when fully opaque, one adaptive filter per row, IHDR/IDAT/IEND only. */
function encodePng(raster: Raster): Buffer {
 const { width, height, rgba } = raster;
 let opaque = true;
 for (let i = 3; i < rgba.length && opaque; i += 4) if (rgba[i] !== 255) opaque = false;
 const channels = opaque ? 3 : 4, stride = width * channels;
 const pixels = new Uint8Array(stride * height);
 for (let p = 0, o = 0; p < rgba.length; p += 4, o += channels) { pixels[o] = rgba[p]; pixels[o + 1] = rgba[p + 1]; pixels[o + 2] = rgba[p + 2]; if (!opaque) pixels[o + 3] = rgba[p + 3]; }
 const filtered = Buffer.alloc((stride + 1) * height);
 const candidate = new Uint8Array(stride), best = new Uint8Array(stride);
 for (let y = 0; y < height; y++) {
  const row = y * stride, prev = row - stride;
  let bestScore = Infinity, bestFilter = 0;
  for (let filter = 0; filter <= 4; filter++) {
   let score = 0;
   for (let i = 0; i < stride; i++) {
    const x = pixels[row + i], a = i >= channels ? pixels[row + i - channels] : 0, b = y > 0 ? pixels[prev + i] : 0, c = y > 0 && i >= channels ? pixels[prev + i - channels] : 0;
    let value: number;
    if (filter === 0) value = x;
    else if (filter === 1) value = x - a;
    else if (filter === 2) value = x - b;
    else if (filter === 3) value = x - ((a + b) >> 1);
    else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
    value &= 255; candidate[i] = value; score += value < 128 ? value : 256 - value;
    if (score >= bestScore) break;
   }
   if (score < bestScore) { bestScore = score; bestFilter = filter; best.set(candidate); }
  }
  filtered[y * (stride + 1)] = bestFilter;
  filtered.set(best, y * (stride + 1) + 1);
 }
 const chunk = (type: string, data: Buffer): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
 };
 const ihdr = Buffer.alloc(13);
 ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
 return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(filtered, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export async function prepareImage(bytes: Buffer, mimeType: string): Promise<PreparedImage> {
 try {
  const policy = IMAGE_PRESENTATION_POLICY;
  requireImage(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= policy.maxOriginalBytes,
   'Image must contain between 1 byte and 64 MiB');
  // Validate an owned snapshot, including when the caller uses shared memory.
  const original = Buffer.from(bytes);
  const header = inspect(original, mimeType);
  let presented: Buffer = original, size = header, presentedType = mimeType;
  // A PNG is decoded whether or not it is resampled, so an original whose pixel
  // data is damaged is reported here rather than attached and refused downstream.
  // JPEG and WebP pixel data is not decoded in this core: their containers are
  // validated and they pass through unchanged when within the preview bounds.
  const raster = mimeType === 'image/png' ? decodePng(original, header) : undefined;
  if (header.width > policy.maxWidth || header.height > policy.maxHeight || base64Length(original.length) > policy.maxBytes) {
   requireImage(raster, `${mimeType} original exceeds the preview bounds and only PNG originals are resampled here; retrieve the original with the host read tool`);
   let width = header.width, height = header.height;
   if (width > policy.maxWidth) { height = Math.round(height * policy.maxWidth / width); width = policy.maxWidth; }
   if (height > policy.maxHeight) { width = Math.round(width * policy.maxHeight / height); height = policy.maxHeight; }
   for (;;) {
    presented = encodePng(resample(raster, Math.max(1, width), Math.max(1, height)));
    size = { width: Math.max(1, width), height: Math.max(1, height) };
    if (base64Length(presented.length) <= policy.maxBytes) break;
    const nextWidth = Math.max(1, Math.floor(width * 0.75)), nextHeight = Math.max(1, Math.floor(height * 0.75));
    requireImage(nextWidth !== width || nextHeight !== height, 'Image cannot be presented within the preview byte bound');
    width = nextWidth; height = nextHeight;
   }
   presentedType = 'image/png';
  }
  const output = inspect(presented, presentedType);
  requireImage(output.width === size.width && output.height === size.height && output.width <= policy.maxWidth && output.height <= policy.maxHeight, 'Presented image dimensions are inconsistent');
  const data = presented.toString('base64');
  requireImage(data.length > 0 && Buffer.byteLength(data, 'utf8') <= policy.maxBytes, 'Presented image exceeds the preview byte bound');
  return {
   content: { type: 'image', data, mimeType: presentedType },
   presentation: {
    originalWidth: header.width, originalHeight: header.height,
    width: size.width, height: size.height, mimeType: presentedType,
    sha256: createHash('sha256').update(presented).digest('hex'), bytes: presented.length,
    transformed: presentedType !== mimeType || !original.equals(presented), policy,
   },
  };
 } catch (error) {
  if (error instanceof PresentationUnavailableError) throw error;
  throw new PresentationUnavailableError('Image presentation failed', { cause: error });
 }
}
