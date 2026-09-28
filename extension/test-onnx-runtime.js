// Test suite for Ticket 08: ONNX Web Runtime Setup, WebGPU check, and WASM fallback

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('--- Running Ticket 08 Verification Tests ---\n');

  // Test 1: manifest.json validation
  console.log('Test 1: Validating manifest.json...');
  const manifestPath = path.join(__dirname, 'manifest.json');
  assert(fs.existsSync(manifestPath), 'manifest.json must exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  assert.strictEqual(manifest.manifest_version, 3, 'Must be Manifest V3');
  assert(manifest.permissions.includes('offscreen'), 'Must include offscreen permission');
  assert(manifest.content_security_policy, 'Must define content_security_policy');
  assert(
    manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"),
    "extension_pages CSP must include 'wasm-unsafe-eval' for WASM compilation"
  );
  assert(
    manifest.content_security_policy.extension_pages.includes("'self'"),
    "extension_pages CSP must include 'self'"
  );
  assert(manifest.web_accessible_resources?.length > 0, 'Must define web_accessible_resources');
  console.log('✓ manifest.json is valid MV3 with correct CSP, offscreen permission, and resources.\n');

  // Test 2: Vendor bundle assets verification
  console.log('Test 2: Verifying vendor bundle assets...');
  const requiredFiles = [
    { file: 'vendor/ort/ort.all.min.mjs', minSize: 500_000 },
    { file: 'vendor/ort/ort.all.min.js', minSize: 500_000 },
    { file: 'vendor/ort/ort-wasm-simd-threaded.wasm', minSize: 10_000_000 },
    { file: 'vendor/ort/ort-wasm-simd-threaded.jsep.wasm', minSize: 15_000_000 },
    { file: 'vendor/transformers/transformers.min.js', minSize: 500_000 }
  ];

  for (const { file, minSize } of requiredFiles) {
    const fullPath = path.join(__dirname, file);
    assert(fs.existsSync(fullPath), `Asset file must exist: ${file}`);
    const stats = fs.statSync(fullPath);
    assert(stats.size >= minSize, `Asset ${file} size ${stats.size} must be >= ${minSize}`);
    console.log(`  ✓ ${file} present (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  }
  console.log('✓ All vendor runtime and WASM assets are properly bundled.\n');

  // Test 3: Offscreen document HTML and structure
  console.log('Test 3: Verifying offscreen.html and offscreen.js...');
  const htmlPath = path.join(__dirname, 'offscreen.html');
  const jsPath = path.join(__dirname, 'offscreen.js');
  assert(fs.existsSync(htmlPath), 'offscreen.html must exist');
  assert(fs.existsSync(jsPath), 'offscreen.js must exist');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  assert(htmlContent.includes('offscreen.js'), 'offscreen.html must reference offscreen.js');
  console.log('✓ offscreen.html and offscreen.js present and linked.\n');

  // Test 4: ORT Web and Transformers.js import and execution
  console.log('Test 4: Testing ONNX Runtime Web and Transformers.js imports...');
  globalThis.self = globalThis;
  const ort = await import('./vendor/ort/ort.all.min.mjs');
  assert(ort.Tensor, 'ort.Tensor must be exported');
  assert(ort.InferenceSession, 'ort.InferenceSession must be exported');

  // Create test tensor
  const tensor = new ort.Tensor('float32', new Float32Array([1.0, 2.0, 3.0, 4.0]), [2, 2]);
  assert.deepStrictEqual(tensor.dims, [2, 2], 'Tensor dimensions must match [2, 2]');
  assert.strictEqual(tensor.type, 'float32', 'Tensor type must be float32');
  console.log('  ✓ ort.Tensor successfully created:', tensor.dims, tensor.type);

  const transformers = await import('./vendor/transformers/transformers.min.js');
  assert(transformers.pipeline || transformers.AutoModel, 'Transformers.js exports must be present');
  console.log('  ✓ Transformers.js loaded successfully');
  console.log('✓ ONNX Runtime Web and Transformers.js modules operate cleanly.\n');

  // Test 5: WebGPU detection and WASM fallback logic
  console.log('Test 5: Testing WebGPU detection & WASM fallback logic...');
  const offscreen = await import('./offscreen.js');

  // Case 5a: No navigator.gpu -> falls back to wasm
  const fallbackResult = await offscreen.detectBackend();
  assert.strictEqual(fallbackResult.selectedBackend, 'wasm', 'Should fallback to wasm when navigator.gpu is absent');
  assert.deepStrictEqual(fallbackResult.executionProviders, ['wasm'], 'Providers should be wasm');
  assert.strictEqual(fallbackResult.webgpu.available, false, 'WebGPU should report unavailable');
  assert(fallbackResult.wasm.available, 'WASM backend should be available');
  console.log('  ✓ WASM fallback works as expected when WebGPU is absent');

  // Case 5b: Mock navigator.gpu available
  const originalGpu = Object.getOwnPropertyDescriptor(globalThis.navigator, 'gpu');
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: {
      requestAdapter: async () => ({
        info: { vendor: 'test-vendor', architecture: 'test-arch', device: 'test-device' },
        requestDevice: async () => ({ destroy: () => {} })
      })
    },
    configurable: true,
    writable: true
  });

  const webgpuResult = await offscreen.detectBackend();
  assert.strictEqual(webgpuResult.selectedBackend, 'webgpu', 'Should select webgpu when navigator.gpu is available');
  assert(webgpuResult.executionProviders.includes('webgpu'), 'Providers should include webgpu');
  assert.strictEqual(webgpuResult.webgpu.available, true, 'WebGPU should report available');
  console.log('  ✓ WebGPU initialization check works with valid adapter');

  // Reset navigator.gpu
  if (originalGpu) {
    Object.defineProperty(globalThis.navigator, 'gpu', originalGpu);
  } else {
    delete globalThis.navigator.gpu;
  }

  // Test 6: Runtime initialization
  console.log('\nTest 6: Testing runtime initialization...');
  const initRes = await offscreen.initRuntime();
  assert(initRes.success, 'initRuntime must succeed');
  assert(initRes.backend === 'wasm' || initRes.backend === 'webgpu', 'Backend must be wasm or webgpu');
  console.log(`✓ initRuntime succeeded with backend: ${initRes.backend}\n`);

  console.log('🎉 All Ticket 08 tests passed successfully!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
