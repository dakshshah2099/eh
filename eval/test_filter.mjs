import { chromium } from 'playwright';
import { runVisionInference } from '../extension/src/vision_inference.js';
import { evaluateDetections, BENCHMARK_CATEGORIES } from './benchmark_ui_detector.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function testFilter() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  for (const cat of BENCHMARK_CATEGORIES) {
    const page = await browser.newPage({ viewport: cat.viewport });
    const html = fs.readFileSync(path.join(FIXTURES_DIR, cat.fixture), 'utf-8');
    await page.setContent(html);

    const gt = await page.evaluate(() => {
      const elms = [];
      const sel = 'button, input:not([type="hidden"]), select, textarea, svg, .btn, .pill-btn, .step-btn, .tbl-btn';
      for (const n of document.querySelectorAll(sel)) {
        const r = n.getBoundingClientRect();
        if (r.width >= 10 && r.height >= 8 && r.top >= 0 && r.top < window.innerHeight && r.left >= 0 && r.left < window.innerWidth) {
          elms.push({ label: 'ui', bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
        }
      }
      return elms;
    });

    const screenshot = await page.screenshot();
    const b64 = 'data:image/png;base64,' + screenshot.toString('base64');

    const dets = await runVisionInference(b64, { confidenceThreshold: 0.65 });
    // Filter out crazy aspect ratios
    const filteredDets = dets.filter(d => {
      const [x, y, w, h] = d.bbox;
      const aspect = w / h;
      return aspect >= 0.4 && aspect <= 8.0 && h <= 90 && w <= 600 && w >= 14 && h >= 12;
    });

    const ev = evaluateDetections(filteredDets, gt, 0.20);
    console.log(`Cat ${cat.id} (GT: ${gt.length}): Dets=${filteredDets.length}, TP=${ev.truePositives}, FP=${ev.falsePositives}, FN=${ev.falseNegatives}, Prec=${(ev.precision*100).toFixed(1)}%, Rec=${(ev.recall*100).toFixed(1)}%, mIoU=${(ev.meanIoU*100).toFixed(1)}%`);

    await page.close();
  }

  await browser.close();
}
testFilter().catch(console.error);
