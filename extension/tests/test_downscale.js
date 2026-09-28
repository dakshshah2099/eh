import assert from 'node:assert/strict';
import { calculateTargetDimensions, blobToBase64 } from '../src/downscale.js';

// Test 1: Calculate target dimensions for landscape image > 768px
{
  const res = calculateTargetDimensions(1920, 1080, 768);
  assert.equal(res.targetWidth, 768);
  assert.equal(res.targetHeight, 432);
  assert.equal(res.scale, 768 / 1920);
  assert.equal(res.originalWidth, 1920);
  assert.equal(res.originalHeight, 1080);
}

// Test 2: Calculate target dimensions for portrait image > 768px
{
  const res = calculateTargetDimensions(1080, 1920, 768);
  assert.equal(res.targetWidth, 432);
  assert.equal(res.targetHeight, 768);
  assert.equal(res.scale, 768 / 1920);
}

// Test 3: Calculate target dimensions for square image > 768px
{
  const res = calculateTargetDimensions(1000, 1000, 768);
  assert.equal(res.targetWidth, 768);
  assert.equal(res.targetHeight, 768);
  assert.equal(res.scale, 0.768);
}

// Test 4: Image smaller than 768px should not be upscaled
{
  const res = calculateTargetDimensions(640, 480, 768);
  assert.equal(res.targetWidth, 640);
  assert.equal(res.targetHeight, 480);
  assert.equal(res.scale, 1.0);
}

// Test 5: Image exactly 768px should stay unchanged
{
  const res = calculateTargetDimensions(768, 512, 768);
  assert.equal(res.targetWidth, 768);
  assert.equal(res.targetHeight, 512);
  assert.equal(res.scale, 1.0);
}

// Test 6: Invalid dimensions should throw
{
  assert.throws(() => calculateTargetDimensions(0, 100, 768), /Invalid dimensions/);
  assert.throws(() => calculateTargetDimensions(100, -10, 768), /Invalid dimensions/);
}

// Test 7: blobToBase64 converts binary blob correctly
{
  const text = 'Hello, world! Privacy Lens Downscaler Test';
  const blob = new Blob([text], { type: 'text/plain' });
  const base64DataUrl = await blobToBase64(blob);
  assert(base64DataUrl.startsWith('data:text/plain;base64,'));
  const encodedPart = base64DataUrl.split(',')[1];
  const decoded = Buffer.from(encodedPart, 'base64').toString('utf-8');
  assert.equal(decoded, text);
}

console.log('All downscale tests passed successfully!');
