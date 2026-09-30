/**
 * @fileoverview Per-Class Recall Evaluation Harness for Privacy Lens Agent.
 * Ticket 03 — Per-class recall eval harness (global scope).
 *
 * Evaluates redaction recall and precision per sensitive-element class:
 * - face: biometric faces, portrait headshots, user avatars
 * - password: password fields, pin/credentials
 * - email: email addresses, email inputs, contact emails
 * - text_pii: free-text personal identity names, author names, user full names
 *
 * Runs headlessly via Playwright against real-world corpus pages (live URLs or saved snapshots).
 * Produces machine-readable JSON report and human-readable Markdown summary tables.
 * Exits with non-zero exit code if overall recall falls below configurable threshold (default: 0.85).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { executePipeline } from '../extension/src/pipeline.js';
import { calculateTargetDimensions } from '../extension/src/downscale.js';
import { parseImageInput } from '../extension/src/face_detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const EVAL_DIR = __dirname;
const CORPUS_DIR = path.join(EVAL_DIR, 'corpus');
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');

const SENSITIVE_CLASSES = ['face', 'password', 'email', 'text_pii'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

/**
 * Creates an ephemeral static HTTP server to serve corpus snapshots.
 * @param {string} rootDir
 * @returns {http.Server}
 */
function createStaticCorpusServer(rootDir) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = req.url.split('?')[0];
    const safePath = path.normalize(path.join(rootDir, reqUrl));

    if (!safePath.startsWith(rootDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(safePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(safePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(safePath).pipe(res);
    });
  });

  return server;
}

/**
 * Creates an in-memory canvas adapter for Playwright screenshot processing.
 * Optionally populates internal pixel buffer from parsed image data.
 */
function createCanvasAdapter(width, height, rawDataUrl = '', pixelSource = null) {
  const buffer = new Uint8ClampedArray(width * height * 4);
  buffer.fill(255); // initialize white

  if (pixelSource && pixelSource.data && pixelSource.width && pixelSource.height) {
    const sw = pixelSource.width;
    const sh = pixelSource.height;
    const sData = pixelSource.data;
    const xRatio = sw / width;
    const yRatio = sh / height;

    for (let dy = 0; dy < height; dy++) {
      const sy = Math.min(sh - 1, Math.floor(dy * yRatio));
      const sRow = sy * sw;
      const dRow = dy * width;
      for (let dx = 0; dx < width; dx++) {
        const sx = Math.min(sw - 1, Math.floor(dx * xRatio));
        const sIdx = (sRow + sx) * 4;
        const dIdx = (dRow + dx) * 4;
        buffer[dIdx] = sData[sIdx];
        buffer[dIdx + 1] = sData[sIdx + 1];
        buffer[dIdx + 2] = sData[sIdx + 2];
        buffer[dIdx + 3] = sData[sIdx + 3];
      }
    }
  }

  const filledRects = [];
  const putImageDataCalls = [];
  const textDrawn = [];

  const ctx = {
    canvas: null,
    fillStyle: '#000000',
    fillRect(x, y, w, h) {
      filledRects.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), fillStyle: this.fillStyle });
      const minX = Math.max(0, Math.round(x));
      const maxX = Math.min(width, Math.round(x + w));
      const minY = Math.max(0, Math.round(y));
      const maxY = Math.min(height, Math.round(y + h));
      for (let py = minY; py < maxY; py++) {
        for (let px = minX; px < maxX; px++) {
          const idx = (py * width + px) * 4;
          buffer[idx] = 0;
          buffer[idx + 1] = 0;
          buffer[idx + 2] = 0;
          buffer[idx + 3] = 255;
        }
      }
    },
    getImageData(x, y, w, h) {
      const rx = Math.max(0, Math.round(x));
      const ry = Math.max(0, Math.round(y));
      const rw = Math.max(1, Math.min(width - rx, Math.round(w)));
      const rh = Math.max(1, Math.min(height - ry, Math.round(h)));
      const data = new Uint8ClampedArray(rw * rh * 4);
      for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
          const srcIdx = ((ry + py) * width + (rx + px)) * 4;
          const dstIdx = (py * rw + px) * 4;
          data[dstIdx] = buffer[srcIdx];
          data[dstIdx + 1] = buffer[srcIdx + 1];
          data[dstIdx + 2] = buffer[srcIdx + 2];
          data[dstIdx + 3] = buffer[srcIdx + 3];
        }
      }
      return { data, width: rw, height: rh };
    },
    putImageData(imgData, x, y) {
      putImageDataCalls.push({ x: Math.round(x), y: Math.round(y), width: imgData.width, height: imgData.height });
      const rx = Math.max(0, Math.round(x));
      const ry = Math.max(0, Math.round(y));
      const rw = imgData.width;
      const rh = imgData.height;
      for (let py = 0; py < rh; py++) {
        for (let px = 0; px < rw; px++) {
          if (rx + px < width && ry + py < height) {
            const srcIdx = (py * rw + px) * 4;
            const dstIdx = ((ry + py) * width + (rx + px)) * 4;
            buffer[dstIdx] = imgData.data[srcIdx];
            buffer[dstIdx + 1] = imgData.data[srcIdx + 1];
            buffer[dstIdx + 2] = imgData.data[srcIdx + 2];
            buffer[dstIdx + 3] = imgData.data[srcIdx + 3];
          }
        }
      }
    },
    fillText(text, x, y) {
      textDrawn.push({ text, x, y });
    },
    drawImage() {},
    save() {},
    restore() {}
  };

  const canvas = {
    width,
    height,
    getContext(type) {
      if (type === '2d') return ctx;
      return null;
    },
    toDataURL(mime = 'image/png') {
      const bpp = 4;
      const raw = Buffer.alloc(height * (1 + width * bpp));
      for (let y = 0; y < height; y++) {
        const rowOffset = y * (1 + width * bpp);
        raw[rowOffset] = 0;
        for (let x = 0; x < width; x++) {
          const pxOffset = rowOffset + 1 + x * bpp;
          const srcIdx = (y * width + x) * bpp;
          raw[pxOffset] = buffer[srcIdx];
          raw[pxOffset + 1] = buffer[srcIdx + 1];
          raw[pxOffset + 2] = buffer[srcIdx + 2];
          raw[pxOffset + 3] = buffer[srcIdx + 3];
        }
      }
      const compressed = zlib.deflateSync(raw);
      const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const ihdr = Buffer.alloc(25);
      ihdr.writeUInt32BE(13, 0);
      ihdr.write('IHDR', 4);
      ihdr.writeUInt32BE(width, 8);
      ihdr.writeUInt32BE(height, 12);
      ihdr[16] = 8;
      ihdr[17] = 6;
      const ihdrCrc = zlib.crc32(ihdr.subarray(4, 17));
      ihdr.writeUInt32BE(ihdrCrc, 21);
      const idat = Buffer.alloc(compressed.length + 12);
      idat.writeUInt32BE(compressed.length, 0);
      idat.write('IDAT', 4);
      compressed.copy(idat, 8);
      const idatCrc = zlib.crc32(idat.subarray(4, 8 + compressed.length));
      idat.writeUInt32BE(idatCrc, 8 + compressed.length);
      const iend = Buffer.alloc(12);
      iend.writeUInt32BE(0, 0);
      iend.write('IEND', 4);
      const iendCrc = zlib.crc32(iend.subarray(4, 8));
      iend.writeUInt32BE(iendCrc, 8);
      return 'data:image/png;base64,' + Buffer.concat([sig, ihdr, idat, iend]).toString('base64');
    },
    _pixelBuffer: buffer,
    _filledRects: filledRects,
    _putImageDataCalls: putImageDataCalls
  };

  ctx.canvas = canvas;
  return canvas;
}

/**
 * Checks whether detected category matches annotation target class.
 * @param {string} annotationClass
 * @param {string} detectedCategory
 * @returns {boolean}
 */
export function isCategoryMatch(annotationClass, detectedCategory) {
  const ann = String(annotationClass || '').toLowerCase().trim();
  const det = String(detectedCategory || '').toLowerCase().trim();

  if (ann === 'face') {
    return det === 'face';
  }
  if (ann === 'password') {
    return det === 'password' || det === 'passwd' || det === 'pwd' || det === 'pin' || det === 'passcode' || det === 'secret';
  }
  if (ann === 'email') {
    return det === 'email';
  }
  if (ann === 'text_pii' || ann === 'name') {
    return det === 'name' || det === 'pii' || det === 'fullname';
  }

  return ann === det;
}

/**
 * Computes spatial overlap and IoU metrics between two bounding boxes.
 * @param {[number, number, number, number]} b1
 * @param {[number, number, number, number]} b2
 * @returns {{ iou: number, coverage: number, overlaps: boolean }}
 */
export function computeSpatialMatch(b1, b2) {
  if (!b1 || !b2 || b1.length < 4 || b2.length < 4) {
    return { iou: 0, coverage: 0, overlaps: false };
  }

  const [x1, y1, w1, h1] = b1;
  const [x2, y2, w2, h2] = b2;

  const ix = Math.max(0, Math.min(x1 + w1, x2 + w2) - Math.max(x1, x2));
  const iy = Math.max(0, Math.min(y1 + h1, y2 + h2) - Math.max(y1, y2));
  const inter = ix * iy;

  if (inter <= 0) {
    return { iou: 0, coverage: 0, overlaps: false };
  }

  const area1 = Math.max(1, w1 * h1);
  const area2 = Math.max(1, w2 * h2);
  const union = area1 + area2 - inter;
  const iou = union > 0 ? inter / union : 0;
  const coverage = inter / Math.min(area1, area2);

  return {
    iou: Number(iou.toFixed(4)),
    coverage: Number(coverage.toFixed(4)),
    overlaps: iou >= 0.10 || coverage >= 0.25
  };
}

/**
 * Checks whether a detected region matches a ground-truth annotation.
 * @param {object} ann - Ground truth annotation object
 * @param {object} det - Detected region object
 * @param {number} scale - Viewport-to-canvas scale
 * @returns {boolean}
 */
export function checkRegionMatch(ann, det, scale = 1.0) {
  // 1. Category must match
  if (!isCategoryMatch(ann.type, det.category)) {
    return false;
  }

  // 2. Selector match
  if (ann.selector && det.selector) {
    const s1 = ann.selector.trim().toLowerCase();
    const s2 = det.selector.trim().toLowerCase();
    if (s1 === s2 || s1.endsWith(s2) || s2.endsWith(s1)) {
      return true;
    }
  }

  // 3. Spatial bounding box match
  const annBox = ann.actualBbox || ann.approxBbox;
  const detBox = det.bbox;

  if (annBox && detBox) {
    // Check against unscaled bbox
    const directMatch = computeSpatialMatch(annBox, detBox);
    if (directMatch.overlaps) return true;

    // Check against scaled bbox
    const scaledAnnBox = [
      Math.round(annBox[0] * scale),
      Math.round(annBox[1] * scale),
      Math.max(1, Math.round(annBox[2] * scale)),
      Math.max(1, Math.round(annBox[3] * scale))
    ];
    const scaledMatch = computeSpatialMatch(scaledAnnBox, detBox);
    if (scaledMatch.overlaps) return true;
  }

  return false;
}

/**
 * Parses command-line arguments.
 * @param {string[]} args
 * @returns {object}
 */
export function parseArgs(args) {
  const options = {
    threshold: 0.85,
    manifestPath: path.join(CORPUS_DIR, 'manifest.json'),
    live: false,
    outputJson: path.join(EVAL_DIR, 'corpus_eval_report.json'),
    outputMd: path.join(EVAL_DIR, 'corpus_eval_summary.md'),
    pageFilter: null,
    verbose: false,
    headless: true
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--threshold' && i + 1 < args.length) {
      options.threshold = parseFloat(args[++i]);
    } else if (arg === '--manifest' && i + 1 < args.length) {
      options.manifestPath = path.resolve(args[++i]);
    } else if (arg === '--output-json' && i + 1 < args.length) {
      options.outputJson = path.resolve(args[++i]);
    } else if (arg === '--output-md' && i + 1 < args.length) {
      options.outputMd = path.resolve(args[++i]);
    } else if (arg === '--page' && i + 1 < args.length) {
      options.pageFilter = args[++i];
    } else if (arg === '--live') {
      options.live = true;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--no-headless') {
      options.headless = false;
    }
  }

  return options;
}

/**
 * Runs the per-class recall evaluation harness.
 * @param {object} [customOptions={}]
 * @returns {Promise<{ success: boolean, report: object }>}
 */
export async function runPerClassEval(customOptions = {}) {
  const cliArgs = parseArgs(process.argv.slice(2));
  const options = { ...cliArgs, ...customOptions };
  const startTime = Date.now();

  console.log('========================================================================');
  console.log('  PRIVACY LENS: PER-CLASS RECALL EVALUATION HARNESS (Ticket 03)');
  console.log('========================================================================\n');
  console.log(`[Config] Target Minimum Recall Threshold: ${(options.threshold * 100).toFixed(1)}%`);
  console.log(`[Config] Manifest Path:                   ${options.manifestPath}`);
  console.log(`[Config] Live URL Mode:                   ${options.live ? 'ENABLED (Fallback to snapshots)' : 'SNAPSHOTS ONLY (Offline Safe)'}`);
  console.log(`[Config] Output JSON:                     ${options.outputJson}`);
  console.log(`[Config] Output Markdown:                 ${options.outputMd}\n`);

  // Verify manifest exists
  if (!fs.existsSync(options.manifestPath)) {
    throw new Error(`Corpus manifest not found at: ${options.manifestPath}`);
  }

  const manifestData = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
  const manifestDir = path.dirname(options.manifestPath);
  let pages = manifestData.pages || [];

  if (options.pageFilter) {
    pages = pages.filter((p) => p.id === options.pageFilter || p.name.includes(options.pageFilter));
    console.log(`[Config] Filtering to ${pages.length} page(s) matching "${options.pageFilter}"\n`);
  }

  if (pages.length === 0) {
    throw new Error('No pages found to evaluate in manifest.');
  }

  console.log(`[Corpus] Evaluating ${pages.length} test page(s) across sensitive classes: ${SENSITIVE_CLASSES.join(', ')}\n`);

  // Start static HTTP server for local snapshot resolution
  const staticServer = createStaticCorpusServer(CORPUS_DIR);
  await new Promise((resolve) => staticServer.listen(0, '127.0.0.1', resolve));
  const serverPort = staticServer.address().port;
  console.log(`[Server] Local snapshot HTTP server listening on http://127.0.0.1:${serverPort}`);

  // Launch Playwright Chromium
  console.log('[Browser] Launching headless browser...');
  const browser = await chromium.launch({
    headless: options.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  // Content script code for in-page DOM skeleton extraction
  const contentScriptPath = path.join(EXTENSION_DIR, 'src', 'content_script.js');
  const contentScriptSource = fs.readFileSync(contentScriptPath, 'utf8');

  // Stats accumulation
  const classStats = {};
  for (const c of SENSITIVE_CLASSES) {
    classStats[c] = { tp: 0, fn: 0, fp: 0, totalGroundTruth: 0, detectedCount: 0 };
  }

  const perPageResults = [];

  try {
    for (let i = 0; i < pages.length; i++) {
      const pageMeta = pages[i];
      const pageIndex = i + 1;
      console.log(`------------------------------------------------------------------------`);
      console.log(`[Page ${pageIndex}/${pages.length}] Evaluating: "${pageMeta.name}" (${pageMeta.id})`);

      let targetUrl = '';
      let urlType = 'snapshot';

      const snapshotRelativePath = pageMeta.snapshot || '';
      const localSnapshotUrl = `http://127.0.0.1:${serverPort}/${snapshotRelativePath}`;

      if (options.live && pageMeta.liveUrl) {
        targetUrl = pageMeta.liveUrl;
        urlType = 'live';
      } else {
        targetUrl = localSnapshotUrl;
        urlType = 'snapshot';
      }

      // Navigate to target URL with fallback
      let navSuccess = false;
      if (urlType === 'live') {
        try {
          console.log(`[Page ${pageIndex}] Attempting live URL: ${targetUrl}...`);
          await page.goto(targetUrl, { timeout: 6000, waitUntil: 'domcontentloaded' });
          navSuccess = true;
        } catch (liveErr) {
          console.warn(`[Page ${pageIndex}] Live URL navigation failed (${liveErr.message}). Falling back to local snapshot.`);
          targetUrl = localSnapshotUrl;
          urlType = 'fallback_snapshot';
        }
      }

      if (!navSuccess) {
        console.log(`[Page ${pageIndex}] Loading snapshot: ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      }

      // Read annotation ground truth
      const annotationFile = path.resolve(manifestDir, pageMeta.annotations);
      let annotationData = { annotations: [], negativeSelectors: [] };
      if (fs.existsSync(annotationFile)) {
        annotationData = JSON.parse(fs.readFileSync(annotationFile, 'utf8'));
      } else {
        console.warn(`[Page ${pageIndex}] Warning: Annotation file missing at ${annotationFile}`);
      }

      const annotations = annotationData.annotations || [];
      const negativeSelectors = annotationData.negativeSelectors || [];

      // Resolve live DOM coordinates for each ground-truth selector
      const resolvedAnnotations = await page.evaluate((anns) => {
        return anns.map((a) => {
          let actualBbox = null;
          let elFound = false;
          let tag = '';
          let textVal = '';

          if (a.selector) {
            try {
              const el = document.querySelector(a.selector);
              if (el) {
                elFound = true;
                tag = (el.tagName || '').toLowerCase();
                const rect = el.getBoundingClientRect();
                actualBbox = [
                  Math.round(rect.left),
                  Math.round(rect.top),
                  Math.max(1, Math.round(rect.width)),
                  Math.max(1, Math.round(rect.height))
                ];
                textVal = String(el.textContent || el.value || '').trim();
              }
            } catch (_) {}
          }

          return {
            ...a,
            foundInDom: elFound,
            actualBbox: actualBbox || a.approxBbox || [0, 0, 0, 0],
            tag,
            textVal
          };
        });
      }, annotations);

      // Extract DOM skeleton in page context
      await page.evaluate(contentScriptSource);
      const skeletonEnvelope = await page.evaluate(() => {
        const root = document.body;
        const skeleton = window.extractDomSkeleton ? window.extractDomSkeleton(root) : [];
        const viewport = {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX || 0,
          scrollY: window.scrollY || 0
        };
        return { skeleton, viewport };
      });

      const rawDomSkeleton = skeletonEnvelope.skeleton;
      const viewport = skeletonEnvelope.viewport;

      // Capture screenshot
      const screenshotBuffer = await page.screenshot({ type: 'png' });
      const rawDataUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;

      // Parse screenshot image data for CV detectors
      let pixelSource = null;
      try {
        pixelSource = await parseImageInput(rawDataUrl);
      } catch (_) {}

      // Calculate target downscaled dimensions
      const { targetWidth, targetHeight, scale } = calculateTargetDimensions(
        viewport.width || 1280,
        viewport.height || 800,
        768
      );

      // Create canvas adapter with real pixel data
      const canvas = createCanvasAdapter(targetWidth, targetHeight, rawDataUrl, pixelSource);

      // Execute extension perception and redaction pipeline
      const pipelineResult = await executePipeline({
        task: `Evaluation audit for page: ${pageMeta.id}`,
        canvas,
        domSkeleton: rawDomSkeleton,
        viewport,
        sendToServer: false,
        enableFaceDetection: true,
        enableOcrDetection: true,
        domOptions: {
          detectFormNames: true,
          detectAvatarElements: true
        }
      });

      const detectedRegions = pipelineResult.mergedRegions || [];
      console.log(`[Page ${pageIndex}] Pipeline executed: ${detectedRegions.length} canonical regions detected.`);

      // Match detections to ground truth annotations
      const pageMatches = [];
      const matchedDetectionIndices = new Set();

      for (const ann of resolvedAnnotations) {
        let isMatched = false;
        let matchedDet = null;

        for (let dIdx = 0; dIdx < detectedRegions.length; dIdx++) {
          const det = detectedRegions[dIdx];
          if (checkRegionMatch(ann, det, scale)) {
            isMatched = true;
            matchedDet = det;
            matchedDetectionIndices.add(dIdx);
            break;
          }
        }

        const normType = ann.type === 'name' ? 'text_pii' : ann.type;
        if (classStats[normType]) {
          classStats[normType].totalGroundTruth++;
          if (isMatched) {
            classStats[normType].tp++;
          } else {
            classStats[normType].fn++;
          }
        }

        pageMatches.push({
          id: ann.id,
          type: normType,
          selector: ann.selector,
          description: ann.description || '',
          groundTruthBbox: ann.actualBbox,
          matched: isMatched,
          matchedCategory: matchedDet?.category || null,
          matchedSource: matchedDet?.source || null,
          status: isMatched ? 'TP' : 'FN (MISSED)'
        });
      }

      // Check remaining detections for false positives
      const pageFalsePositives = [];
      for (let dIdx = 0; dIdx < detectedRegions.length; dIdx++) {
        const det = detectedRegions[dIdx];
        const matchesAnyAnnotation = resolvedAnnotations.some((ann) => checkRegionMatch(ann, det, scale));
        if (!matchesAnyAnnotation) {
          let normCat = det.category;
          if (normCat === 'name' || normCat === 'pii') normCat = 'text_pii';
          if (normCat === 'pin') normCat = 'password';

          if (classStats[normCat]) {
            classStats[normCat].fp++;
            pageFalsePositives.push({
              category: normCat,
              selector: det.selector || 'unknown',
              bbox: det.bbox,
              source: det.source
            });
          }
        }
      }

      const pageTP = pageMatches.filter((m) => m.matched).length;
      const pageFN = pageMatches.filter((m) => !m.matched).length;
      const pageFP = pageFalsePositives.length;
      const pageRecall = pageMatches.length > 0 ? pageTP / (pageTP + pageFN) : 1.0;
      const pagePrecision = (pageTP + pageFP) > 0 ? pageTP / (pageTP + pageFP) : 1.0;

      console.log(`[Page ${pageIndex}] Results: ${pageTP}/${pageMatches.length} Ground Truth Detected | Recall: ${(pageRecall * 100).toFixed(1)}% | Precision: ${(pagePrecision * 100).toFixed(1)}%`);

      perPageResults.push({
        id: pageMeta.id,
        name: pageMeta.name,
        url: targetUrl,
        urlType,
        totalGroundTruth: pageMatches.length,
        truePositives: pageTP,
        falseNegatives: pageFN,
        falsePositives: pageFP,
        recall: Number(pageRecall.toFixed(4)),
        precision: Number(pagePrecision.toFixed(4)),
        annotations: pageMatches,
        extraDetections: pageFalsePositives
      });
    }

    // Compute aggregate per-class metrics
    const perClassReport = {};
    let overallTP = 0;
    let overallFN = 0;
    let overallFP = 0;

    for (const c of SENSITIVE_CLASSES) {
      const s = classStats[c];
      const recall = (s.tp + s.fn) > 0 ? s.tp / (s.tp + s.fn) : 1.0;
      const precision = (s.tp + s.fp) > 0 ? s.tp / (s.tp + s.fp) : 1.0;
      const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

      perClassReport[c] = {
        class: c,
        groundTruth: s.totalGroundTruth,
        truePositives: s.tp,
        falseNegatives: s.fn,
        falsePositives: s.fp,
        recall: Number(recall.toFixed(4)),
        precision: Number(precision.toFixed(4)),
        f1Score: Number(f1.toFixed(4))
      };

      overallTP += s.tp;
      overallFN += s.fn;
      overallFP += s.fp;
    }

    const overallGroundTruth = overallTP + overallFN;
    const overallRecall = overallGroundTruth > 0 ? overallTP / overallGroundTruth : 1.0;
    const overallPrecision = (overallTP + overallFP) > 0 ? overallTP / (overallTP + overallFP) : 1.0;
    const overallF1 = (overallPrecision + overallRecall) > 0
      ? (2 * overallPrecision * overallRecall) / (overallPrecision + overallRecall)
      : 0;

    const durationMs = Date.now() - startTime;
    const passed = overallRecall >= options.threshold;

    const report = {
      timestamp: new Date().toISOString(),
      durationMs,
      threshold: options.threshold,
      passed,
      summary: {
        overallRecall: Number(overallRecall.toFixed(4)),
        overallPrecision: Number(overallPrecision.toFixed(4)),
        overallF1: Number(overallF1.toFixed(4)),
        totalGroundTruth: overallGroundTruth,
        totalTruePositives: overallTP,
        totalFalseNegatives: overallFN,
        totalFalsePositives: overallFP,
        totalPagesEvaluated: pages.length
      },
      perClass: perClassReport,
      perPage: perPageResults
    };

    // Output JSON report
    fs.mkdirSync(path.dirname(options.outputJson), { recursive: true });
    fs.writeFileSync(options.outputJson, JSON.stringify(report, null, 2), 'utf8');
    const standardReportJson = path.join(EVAL_DIR, 'eval_report.json');
    if (options.outputJson !== standardReportJson) {
      fs.writeFileSync(standardReportJson, JSON.stringify(report, null, 2), 'utf8');
    }
    console.log(`\n[Report] JSON report written to: ${options.outputJson}`);

    // Output Markdown summary
    const summaryMd = generateMarkdownSummary(report, options);
    fs.mkdirSync(path.dirname(options.outputMd), { recursive: true });
    fs.writeFileSync(options.outputMd, summaryMd, 'utf8');
    const standardSummaryMd = path.join(EVAL_DIR, 'eval_summary.md');
    if (options.outputMd !== standardSummaryMd) {
      fs.writeFileSync(standardSummaryMd, summaryMd, 'utf8');
    }
    console.log(`[Report] Markdown summary written to: ${options.outputMd}\n`);

    // Output console Markdown table
    console.log(summaryMd);

    if (passed) {
      console.log(`\n✅ [PASS] Overall recall of ${(overallRecall * 100).toFixed(2)}% MEETS required threshold (${(options.threshold * 100).toFixed(1)}%).\n`);
    } else {
      console.error(`\n❌ [FAIL] Overall recall of ${(overallRecall * 100).toFixed(2)}% FELL BELOW required threshold (${(options.threshold * 100).toFixed(1)}%).\n`);
    }

    return {
      success: passed,
      report
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => staticServer.close(resolve));
  }
}

/**
 * Generates formatted Markdown report.
 * @param {object} report
 * @param {object} options
 * @returns {string}
 */
export function generateMarkdownSummary(report, options) {
  const s = report.summary;
  const p = report.perClass;

  const classRows = Object.values(p).map((c) => {
    const className = c.class.toUpperCase();
    const recallPct = (c.recall * 100).toFixed(2) + '%';
    const precPct = (c.precision * 100).toFixed(2) + '%';
    const f1Pct = (c.f1Score * 100).toFixed(2) + '%';
    const status = c.recall >= options.threshold ? '✅ PASS' : '⚠️ WARN';
    return `| **${className}** | ${c.groundTruth} | ${c.truePositives} | ${c.falseNegatives} | ${c.falsePositives} | **${recallPct}** | ${precPct} | ${f1Pct} | ${status} |`;
  }).join('\n');

  const pageRows = report.perPage.map((page) => {
    const recallPct = (page.recall * 100).toFixed(1) + '%';
    const precPct = (page.precision * 100).toFixed(1) + '%';
    const status = page.falseNegatives === 0 ? '✅ 100%' : (page.recall >= options.threshold ? '✅ PASS' : '❌ FAIL');
    return `| \`${page.id}\` | ${page.name} | ${page.totalGroundTruth} | ${page.truePositives} | ${page.falseNegatives} | ${recallPct} | ${precPct} | ${status} |`;
  }).join('\n');

  return `# Per-Class Recall Evaluation Report (Ticket 03)

**Execution Date:** ${report.timestamp}  
**Total Runtime:** ${report.durationMs}ms  
**Corpus Pages Evaluated:** ${s.totalPagesEvaluated}  
**Target Recall Threshold:** ${(options.threshold * 100).toFixed(1)}%  
**Overall Verdict:** **${report.passed ? 'PASSED ✅' : 'FAILED ❌'}**

---

## 1. Per-Class Recall & Precision Breakdown

| Sensitive Class | Ground Truth | True Positives (TP) | False Negatives (FN) | False Positives (FP) | Recall | Precision | F1-Score | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
${classRows}
| **OVERALL TOTAL** | **${s.totalGroundTruth}** | **${s.totalTruePositives}** | **${s.totalFalseNegatives}** | **${s.totalFalsePositives}** | **${(s.overallRecall * 100).toFixed(2)}%** | **${(s.overallPrecision * 100).toFixed(2)}%** | **${(s.overallF1 * 100).toFixed(2)}%** | **${report.passed ? '✅ PASS' : '❌ FAIL'}** |

---

## 2. Per-Page Evaluation Results

| Page ID | Scenario Description | GT Items | TP | FN | Recall | Precision | Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
${pageRows}

---

## 3. Judge & Finale Execution Guide

Judges can execute this harness independently on any new page set revealed at the finale:

\`\`\`bash
# 1. Run the default 12-page evaluation corpus:
npm run eval

# 2. Run with custom recall threshold (e.g. 0.90):
node eval/run_eval.js --threshold 0.90

# 3. Run against an independent custom finale manifest:
node eval/run_eval.js --manifest path/to/finale_manifest.json

# 4. Attempt live URLs first with automatic fallback to snapshots:
node eval/run_eval.js --live
\`\`\`
`;
}

// CLI Execution Entry Point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPerClassEval()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('\n❌ Evaluation Harness Execution Error:', err);
      process.exit(1);
    });
}
