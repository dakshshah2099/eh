import { chromium } from 'playwright';
import { runVisionInference } from '../extension/src/vision_inference.js';
import fs from 'node:fs';

async function test() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const html = fs.readFileSync('./fixtures/forms.html', 'utf-8');
  await page.setContent(html);
  const screenshot = await page.screenshot();
  const b64 = 'data:image/png;base64,' + screenshot.toString('base64');

  const gt = await page.evaluate(() => {
    const elms = [];
    const selectors = ['button', 'input:not([type="hidden"])', 'select', 'svg', 'h1', 'h2'];
    for (const s of selectors) {
      for (const n of document.querySelectorAll(s)) {
        const r = n.getBoundingClientRect();
        if (r.width > 10 && r.height > 8) {
          elms.push({ tag: n.tagName, text: n.innerText || n.placeholder || n.id, bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
        }
      }
    }
    return elms;
  });

  console.log('--- Ground Truth (first 10) ---');
  for (const g of gt.slice(0, 10)) {
    console.log(`  GT: ${g.tag} "${g.text}" => bbox: ${JSON.stringify(g.bbox)}`);
  }

  const dets = await runVisionInference(b64, { confidenceThreshold: 0.25 });
  console.log('\n--- Detections (first 10) ---');
  for (const d of dets.slice(0, 10)) {
    console.log(`  Det: ${d.label} (conf: ${d.confidence}) => bbox: ${JSON.stringify(d.bbox)}`);
  }

  await browser.close();
}
test().catch(console.error);
