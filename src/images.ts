// Images for the model: read from the client's payload at the profile's
// `images.path`, checked, and sent to the model beside the state (Clef's
// `images`, docs/profile-format.md "Images"). Images are never stored: the
// decision log keeps a hash of the state and of each image (src/decide.ts).
//
// Checked here, before any model call: at most `images.max` (up to 4), each a
// base64 data URL of a PNG, JPEG or WebP whose first bytes are that format,
// at most 4 MiB decoded, at most 8 MiB together (Clef's limits). A missing
// path or an empty list is no images; anything else is refused.

import { resolvePath } from './input';
import type { Profile } from './types';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 8 * 1024 * 1024;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

/** The first bytes of each allowed format (WebP: "RIFF" then "WEBP" at offset 8). */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
};

export type ImagesResult = { ok: true; images: string[] } | { ok: false; message: string };

/** Decoded size of base64 text (without decoding it). */
function decodedBytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** The images for one decision; never throws. Messages name the image by its place, never its content. */
export function readImages(profile: Profile, payload: unknown): ImagesResult {
  if (!profile.images) return { ok: true, images: [] };
  const max = Math.min(profile.images.max ?? MAX_IMAGES, MAX_IMAGES);
  const raw = resolvePath(payload, profile.images.path);
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > max) return { ok: false, message: `at most ${max} images` };
  let total = 0;
  for (const [i, item] of list.entries()) {
    const m = typeof item === 'string' ? DATA_URL.exec(item) : null;
    if (!m || m[2]!.length % 4 !== 0 || m[2]!.length === 0) {
      return { ok: false, message: `image ${i + 1}: must be a base64 data URL of a PNG, JPEG or WebP image` };
    }
    const bytes = decodedBytes(m[2]!);
    if (bytes > MAX_IMAGE_BYTES) return { ok: false, message: `image ${i + 1}: at most 4 MiB` };
    let head: Uint8Array;
    try {
      head = Uint8Array.from(atob(m[2]!.slice(0, 16)), (c) => c.charCodeAt(0));
    } catch {
      return { ok: false, message: `image ${i + 1}: not valid base64` };
    }
    if (!SIGNATURES[m[1]!]!(head)) return { ok: false, message: `image ${i + 1}: the data is not a ${m[1]} image` };
    total += bytes;
  }
  if (total > MAX_IMAGES_BYTES) return { ok: false, message: 'at most 8 MiB of images together' };
  return { ok: true, images: list as string[] };
}
