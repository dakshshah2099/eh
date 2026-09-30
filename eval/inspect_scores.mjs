import { chromium } from 'playwright';
import { runVisionInference, loadVisionModel, preprocessImage } from '../extension/src/vision_inference.js';
import fs from 'node:fs';

async function test() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const html = fs.readFileSync('./fixtures/forms.html', 'utf-8');
  await page.setContent(html);
  const screenshot = await page.screenshot();
  const b64 = 'data:image/png;base64,' + screenshot.toString('base64');
  
  const meta = await loadVisionModel();
  const prep = await preprocessImage(b64, 256, 256);
  const out = await meta.session.run({ images: prep.inputTensor });
  console.log('ONNX scores min/max:');
  const scores = out.scores.data;
  let min = 1, max = 0;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < min) min = scores[i];
    if (scores[i] > max) max = scores[i];
  }
  console.log('min score:', min, 'max score:', max);

  const dets = await runVisionInference(b64, { confidenceThreshold: 0.25 });
  console.log('Detections count:', dets.length);
  console.log('First 5 detections:', dets.slice(0, 5));

  await browser.close();
}
test().catch(console.error);
