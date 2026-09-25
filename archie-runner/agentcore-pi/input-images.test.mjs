// Guards the multimodal-input contract: a well-formed images array normalises to
// Pi ImageContent, absent/empty is a text turn, and anything malformed is a
// distinct sentinel so the adapter can 400 rather than silently drop it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseInputImages, INVALID_IMAGES, MAX_IMAGES } from './input-images.mjs';

test('absent or empty input is a text turn (empty array, not invalid)', () => {
  assert.deepEqual(normaliseInputImages(undefined), []);
  assert.deepEqual(normaliseInputImages(null), []);
  assert.deepEqual(normaliseInputImages([]), []);
});

test('well-formed images normalise to ImageContent', () => {
  const out = normaliseInputImages([
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { data: 'BBBB', mimeType: 'image/jpeg' }, // type is added
  ]);
  assert.deepEqual(out, [
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
  ]);
});

test('accepts mime_type as well as mimeType', () => {
  const out = normaliseInputImages([{ data: 'AAAA', mime_type: 'image/webp' }]);
  assert.deepEqual(out, [{ type: 'image', data: 'AAAA', mimeType: 'image/webp' }]);
});

test('a non-array images field is invalid (not an empty turn)', () => {
  assert.equal(normaliseInputImages('nope'), INVALID_IMAGES);
  assert.equal(normaliseInputImages({ data: 'x' }), INVALID_IMAGES);
});

test('missing or bad data/mime is invalid', () => {
  assert.equal(normaliseInputImages([{ mimeType: 'image/png' }]), INVALID_IMAGES);
  assert.equal(normaliseInputImages([{ data: '', mimeType: 'image/png' }]), INVALID_IMAGES);
  assert.equal(normaliseInputImages([{ data: 'AAAA', mimeType: 'application/pdf' }]), INVALID_IMAGES);
  assert.equal(normaliseInputImages([{ data: 'AAAA' }]), INVALID_IMAGES);
  assert.equal(normaliseInputImages([null]), INVALID_IMAGES);
});

test('too many images is invalid', () => {
  const many = Array.from({ length: MAX_IMAGES + 1 }, () => ({ data: 'AAAA', mimeType: 'image/png' }));
  assert.equal(normaliseInputImages(many), INVALID_IMAGES);
});
