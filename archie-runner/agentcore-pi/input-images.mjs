// Validation + normalisation for multimodal turn input.
//
// `input.images` on an /invocations (and /stream) request is an array of Pi
// ImageContent objects: { type:'image', data:<base64>, mimeType }. This module
// is the single place that shape is checked, so a malformed image fails fast
// with a 400 rather than deep inside Pi — mirroring how prompt validation
// rejects a bad prompt up front. Kept import-free and side-effect-free so it is
// trivially unit-testable (pi-adapter.mjs boots a server at import).

// A distinct sentinel separates "caller sent a malformed images field" (→ 400)
// from "no images" (→ a normal text turn). Returning [] for both would make a
// typo silently drop the images instead of reporting it.
export const INVALID_IMAGES = Symbol('invalid-images');

// Guard a runaway payload. Pi itself enforces the per-request byte/pixel limits;
// this only bounds the count so a huge array is rejected before base64 decode.
export const MAX_IMAGES = 16;

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|heic|tiff)$/i;

/**
 * @param raw the request's `input.images` (or `images`) value
 * @returns a normalised ImageContent[] (possibly empty), or INVALID_IMAGES
 */
export function normaliseInputImages(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return INVALID_IMAGES;
  if (raw.length === 0) return [];
  if (raw.length > MAX_IMAGES) return INVALID_IMAGES;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return INVALID_IMAGES;
    const data = item.data;
    const mimeType = item.mimeType || item.mime_type;
    if (typeof data !== 'string' || data.length === 0) return INVALID_IMAGES;
    if (typeof mimeType !== 'string' || !IMAGE_MIME.test(mimeType)) return INVALID_IMAGES;
    out.push({ type: 'image', data, mimeType });
  }
  return out;
}
