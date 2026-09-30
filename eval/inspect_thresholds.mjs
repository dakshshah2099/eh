import { chromium } from 'playwright';
import { runVisionInference, loadVisionModel, preprocessImage } from '../extension/src/vision_inference.js';
import { evaluateDetections } from './benchmark_ui_detector.js';
import fs from 'node:fs';

async function test() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const html = fs.readFileSync('./fixtures/forms.html', 'utf-8');
  await page.setContent(html);
  const screenshot = await page.screenshot();
  const b64 = 'data:image/png;base64,' + screenshot.toString('base64');

  // Extract GT
  const gt = await page.evaluate(() => {
    const elms = [];
    const selectors = ['button', 'input:not([type="hidden"])', 'select', 'svg', 'h1', 'h2'];
    for (const s of selectors) {
      for (const n of document.querySelectorAll(s)) {
        const r = n.getBoundingClientRect();
        if (r.width > 10 && r.height > 8) {
          elms.push({ label: 'ui', bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
        }
      }
    }
    return elms;
  });

  console.log(`Ground truth elements: ${gt.length}`);

  for (const conf of [0.60, 0.65, 0.70, 0.75, 0.78, 0.80]) {
    const dets = await runVisionInference(b64, { confidenceThreshold: conf, iouThreshold: 0.3 });
    const ev = evaluateDetections(dets, gt, 0.25);
    console.log(`Conf ${conf}: Detections=${dets.length}, TP=${ev.truePositives}, FP=${ev.falsePositives}, FN=${ev.falseNegatives}, Precision=${(ev.precision*100).toFixed(1)}%, Recall=${(ev.recall*100).toFixed(1)}%, mIoU=${(ev.meanIoU*100).toFixed(1)}%`);
  }

  await browser.close();
}
test().catch(console.error);
