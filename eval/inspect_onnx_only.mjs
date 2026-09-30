import { chromium } from 'playwright';
import { loadVisionModel, preprocessImage } from '../extension/src/vision_inference.js';
import fs from 'node:fs';

async function test() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const html = fs.readFileSync('./fixtures/forms.html', 'utf-8');
  await page.setContent(html);
  const screenshot = await page.screenshot();
  const b64 = 'data:image/png;base64,' + screenshot.toString('base64');

  const meta = await loadVisionModel();
  const { inputTensor, origWidth, origHeight } = await preprocessImage(b64, 256, 256);
  const outputs = await meta.session.run({ images: inputTensor });

  const boxesData = outputs.boxes.data;
  const scoresData = outputs.scores.data;
  const numBoxes = outputs.boxes.dims[1];

  console.log(`ONNX returned ${numBoxes} boxes`);
  const onnxDetections = [];
  for (let i = 0; i < numBoxes; i++) {
    const bOffset = i * 4;
    const sOffset = i * 4;

    const cx = boxesData[bOffset];
    const cy = boxesData[bOffset + 1];
    const bw = boxesData[bOffset + 2];
    const bh = boxesData[bOffset + 3];

    let bestClassIdx = 0;
    let maxScore = scoresData[sOffset];
    for (let c = 1; c < 4; c++) {
      if (scoresData[sOffset + c] > maxScore) {
        maxScore = scoresData[sOffset + c];
        bestClassIdx = c;
      }
    }

    if (maxScore >= 0.70) {
      const px = Math.max(0, Math.min(origWidth - 1, Math.round((cx - bw / 2) * origWidth)));
      const py = Math.max(0, Math.min(origHeight - 1, Math.round((cy - bh / 2) * origHeight)));
      const pw = Math.max(1, Math.min(origWidth - px, Math.round(bw * origWidth)));
      const ph = Math.max(1, Math.min(origHeight - py, Math.round(bh * origHeight)));

      onnxDetections.push({
        box: [px, py, pw, ph],
        cls: bestClassIdx,
        score: maxScore
      });
    }
  }

  console.log(`Detections with score >= 0.70: ${onnxDetections.length}`);
  for (const d of onnxDetections.slice(0, 5)) {
    console.log(`  score=${d.score.toFixed(3)}, box=${JSON.stringify(d.box)}`);
  }

  await browser.close();
}
test().catch(console.error);
