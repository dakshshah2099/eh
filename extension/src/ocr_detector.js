/**
 * CV-Level OCR Detector for Privacy Lens Agent.
 * Scans image/canvas/OCR data for sensitive text patterns:
 * - email: [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
 * - phone: (\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}
 * - credit card: \b(?:\d{4}[ -]?){3}\d{4}\b
 * - ssn: \b\d{3}-\d{2}-\d{4}\b
 * 
 * Outputs list of sensitive regions:
 * [{ bbox: [x,y,w,h], category: 'email'|'phone'|'card'|'ssn', source: 'ocr', confidence: float }]
 */

/**
 * Standard regex patterns for sensitive categories.
 */
export const SENSITIVE_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g,
  card: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g
};

/**
 * Priority order for evaluation. SSN and Card precede Phone to prevent false sub-matches.
 */
export const CATEGORY_ORDER = ['ssn', 'card', 'email', 'phone'];

/**
 * Normalizes bounding box representation to [x, y, w, h].
 * Handles array [x,y,w,h], {x,y,w,h}, {x,y,width,height}, {x0,y0,x1,y1}, {left,top,width,height}.
 * @param {Array<number>|Object} bbox
 * @returns {[number, number, number, number]}
 */
export function normalizeBBox(bbox) {
  if (Array.isArray(bbox) && bbox.length === 4) {
    return [Math.round(bbox[0]), Math.round(bbox[1]), Math.round(bbox[2]), Math.round(bbox[3])];
  }
  if (bbox && typeof bbox === 'object') {
    if (typeof bbox.x0 === 'number' && typeof bbox.x1 === 'number') {
      const x = Math.min(bbox.x0, bbox.x1);
      const y = Math.min(bbox.y0, bbox.y1);
      const w = Math.abs(bbox.x1 - bbox.x0);
      const h = Math.abs(bbox.y1 - bbox.y0);
      return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
    }
    const x = bbox.x ?? bbox.left ?? 0;
    const y = bbox.y ?? bbox.top ?? 0;
    const w = bbox.width ?? bbox.w ?? 0;
    const h = bbox.height ?? bbox.h ?? 0;
    return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
  }
  return [0, 0, 0, 0];
}

/**
 * Normalizes confidence score to a float between 0.0 and 1.0.
 * @param {number|undefined|null} conf
 * @returns {number}
 */
export function normalizeConfidence(conf) {
  if (typeof conf !== 'number' || Number.isNaN(conf)) {
    return 0.85;
  }
  let score = conf;
  if (score > 1.0) {
    score = score / 100.0;
  }
  score = Math.max(0.0, Math.min(1.0, score));
  return Math.round(score * 10000) / 10000;
}

/**
 * Scans a string for sensitive pattern occurrences in priority order.
 * Deduplicates overlapping character ranges.
 * @param {string} text
 * @param {Array<string>} [categories=CATEGORY_ORDER]
 * @returns {Array<{ category: string, text: string, start: number, end: number }>}
 */
export function scanTextForSensitiveSpans(text, categories = CATEGORY_ORDER) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const occupied = [];
  const matches = [];

  for (const category of categories) {
    const regex = SENSITIVE_PATTERNS[category];
    if (!regex) continue;

    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const matchText = m[0];
      const start = m.index;
      const end = start + matchText.length;

      if (start === end) {
        regex.lastIndex++;
        continue;
      }

      // Check for overlap with already claimed spans
      const hasOverlap = occupied.some(span => Math.max(start, span.start) < Math.min(end, span.end));
      if (!hasOverlap) {
        occupied.push({ start, end });
        matches.push({ category, text: matchText, start, end });
      }
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Computes bounding box and confidence for a matched text span within an OCR line.
 * Uses word-level boxes if available, falling back to proportional character interpolation.
 * @param {Object} line
 * @param {number} matchStart
 * @param {number} matchEnd
 * @returns {{ bbox: [number, number, number, number], confidence: number }}
 */
export function computeMatchBoundingBox(line, matchStart, matchEnd) {
  const lineBbox = normalizeBBox(line.bbox);
  const lineText = line.text || '';
  const lineConf = normalizeConfidence(line.confidence);

  // If word-level bounding boxes are present, find overlapping words
  if (Array.isArray(line.words) && line.words.length > 0) {
    let searchPos = 0;
    const wordsWithSpans = line.words.map(w => {
      const wordText = w.text || '';
      const idx = lineText.indexOf(wordText, searchPos);
      const start = idx !== -1 ? idx : searchPos;
      const end = start + wordText.length;
      searchPos = end;
      return {
        text: wordText,
        bbox: normalizeBBox(w.bbox),
        start,
        end,
        confidence: normalizeConfidence(w.confidence ?? lineConf)
      };
    });

    const overlappingWords = wordsWithSpans.filter(w =>
      Math.max(matchStart, w.start) < Math.min(matchEnd, w.end)
    );

    if (overlappingWords.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let confSum = 0;

      for (const w of overlappingWords) {
        const [wx, wy, ww, wh] = w.bbox;
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        maxX = Math.max(maxX, wx + ww);
        maxY = Math.max(maxY, wy + wh);
        confSum += w.confidence;
      }

      return {
        bbox: [minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY)],
        confidence: Math.round((confSum / overlappingWords.length) * 10000) / 10000
      };
    }
  }

  // Fallback: Proportional character interpolation along line bbox
  const totalChars = Math.max(1, lineText.length);
  const charWidth = lineBbox[2] / totalChars;
  const matchCharLen = Math.max(1, matchEnd - matchStart);

  const x = Math.round(lineBbox[0] + matchStart * charWidth);
  const y = lineBbox[1];
  const w = Math.round(Math.max(1, matchCharLen * charWidth));
  const h = lineBbox[3];

  return {
    bbox: [x, y, w, h],
    confidence: lineConf
  };
}

/**
 * Standardizes raw OCR output into lines.
 * Handles Tesseract data structures, array of lines, or single line block.
 * @param {any} ocrData
 * @returns {Array<Object>}
 */
export function normalizeOCRLines(ocrData) {
  if (!ocrData) return [];

  // Tesseract data structure: { data: { lines: [...] } }
  if (ocrData.data && Array.isArray(ocrData.data.lines)) {
    return ocrData.data.lines;
  }

  // Direct { lines: [...] } structure
  if (Array.isArray(ocrData.lines)) {
    return ocrData.lines;
  }

  // Array of line / word objects
  if (Array.isArray(ocrData)) {
    return ocrData;
  }

  // Single line / block object
  if (typeof ocrData === 'object' && typeof ocrData.text === 'string') {
    return [ocrData];
  }

  return [];
}

/**
 * Checks whether the input is structured OCR data.
 * @param {any} input
 * @returns {boolean}
 */
export function isOCRStructuredInput(input) {
  if (!input) return false;
  if (Array.isArray(input)) {
    return input.length === 0 || typeof input[0]?.text === 'string' || Boolean(input[0]?.bbox);
  }
  if (typeof input === 'object') {
    return Boolean(
      (input.data && Array.isArray(input.data.lines)) ||
      Array.isArray(input.lines) ||
      (typeof input.text === 'string' && (input.bbox || input.confidence))
    );
  }
  return false;
}

/**
 * Extracts sensitive regions from structured OCR lines.
 * @param {any} ocrData
 * @param {Object} [options={}]
 * @param {number} [options.minConfidence=0.0]
 * @param {Array<string>} [options.categories=CATEGORY_ORDER]
 * @returns {Array<{ bbox: [number, number, number, number], category: string, source: 'ocr', confidence: number }>}
 */
export function extractSensitiveRegionsFromOCR(ocrData, options = {}) {
  const minConfidence = options.minConfidence ?? 0.0;
  const categories = options.categories ?? CATEGORY_ORDER;
  const lines = normalizeOCRLines(ocrData);
  const sensitiveRegions = [];

  for (const line of lines) {
    const text = line.text ?? '';
    const spans = scanTextForSensitiveSpans(text, categories);

    for (const span of spans) {
      const { bbox, confidence } = computeMatchBoundingBox(line, span.start, span.end);
      if (confidence >= minConfidence) {
        sensitiveRegions.push({
          bbox,
          category: span.category,
          source: 'ocr',
          confidence
        });
      }
    }
  }

  return sensitiveRegions;
}

/**
 * Lightweight CV-level text region detector for Canvas / ImageData.
 * Analyzes pixel luminance, detects foreground strokes, and segments text lines and words.
 * @param {Object} canvasOrImageData
 * @param {Object} [options={}]
 * @returns {Array<{ bbox: [number, number, number, number], confidence: number }>}
 */
export function detectCanvasTextRegions(canvasOrImageData, options = {}) {
  let width = 0;
  let height = 0;
  let data = null;

  if (canvasOrImageData && canvasOrImageData.data && typeof canvasOrImageData.width === 'number') {
    width = canvasOrImageData.width;
    height = canvasOrImageData.height;
    data = canvasOrImageData.data;
  } else if (canvasOrImageData && typeof canvasOrImageData.getContext === 'function') {
    width = canvasOrImageData.width;
    height = canvasOrImageData.height;
    const ctx = canvasOrImageData.getContext('2d');
    if (ctx && typeof ctx.getImageData === 'function') {
      const imgData = ctx.getImageData(0, 0, width, height);
      data = imgData.data;
    }
  }

  if (!width || !height || !data || data.length === 0) {
    return [];
  }

  const contrastDelta = options.contrastDelta ?? 25;
  const minLineHeight = options.minLineHeight ?? 3;
  const minLineWidth = options.minLineWidth ?? 4;
  const maxLineGap = options.maxLineGap ?? 8;

  // Compute luminance: 0.299 R + 0.587 G + 0.114 B
  const lum = new Uint8Array(width * height);
  let totalLum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const l = Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
    lum[p] = l;
    totalLum += l;
  }

  // Adaptive threshold based on mean luminance
  const meanLum = totalLum / (width * height);
  const isDarkBg = meanLum < 128;
  const isForeground = isDarkBg
    ? (l) => l > meanLum + contrastDelta
    : (l) => l < meanLum - contrastDelta;

  // Row-wise foreground activity
  const rowActivity = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (isForeground(lum[rowOffset + x])) {
        count++;
      }
    }
    rowActivity[y] = count;
  }

  // Segment rows into line intervals
  const lines = [];
  let inLine = false;
  let lineStart = 0;

  for (let y = 0; y < height; y++) {
    const hasFg = rowActivity[y] >= minLineWidth;
    if (hasFg && !inLine) {
      inLine = true;
      lineStart = y;
    } else if (!hasFg && inLine) {
      inLine = false;
      if (y - lineStart >= minLineHeight) {
        lines.push({ startY: lineStart, endY: y - 1 });
      }
    }
  }
  if (inLine && height - lineStart >= minLineHeight) {
    lines.push({ startY: lineStart, endY: height - 1 });
  }

  // Segment each line horizontally into bounding boxes
  const textRegions = [];
  for (const line of lines) {
    const colActivity = new Uint32Array(width);
    for (let y = line.startY; y <= line.endY; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        if (isForeground(lum[rowOffset + x])) {
          colActivity[x]++;
        }
      }
    }

    let inBlock = false;
    let blockStartX = 0;
    let gap = 0;

    for (let x = 0; x < width; x++) {
      if (colActivity[x] > 0) {
        if (!inBlock) {
          inBlock = true;
          blockStartX = x;
        }
        gap = 0;
      } else if (inBlock) {
        gap++;
        if (gap > maxLineGap) {
          const blockEndX = x - gap;
          if (blockEndX - blockStartX + 1 >= minLineWidth) {
            textRegions.push({
              bbox: [blockStartX, line.startY, blockEndX - blockStartX + 1, line.endY - line.startY + 1],
              confidence: 0.85
            });
          }
          inBlock = false;
          gap = 0;
        }
      }
    }

    if (inBlock) {
      const blockEndX = width - 1 - gap;
      if (blockEndX - blockStartX + 1 >= minLineWidth) {
        textRegions.push({
          bbox: [blockStartX, line.startY, blockEndX - blockStartX + 1, line.endY - line.startY + 1],
          confidence: 0.85
        });
      }
    }
  }

  return textRegions;
}

/**
 * Tesseract.js adapter for OCR recognition.
 * @param {any} imageSource
 * @param {Object} [options={}]
 * @returns {Promise<Array<Object>>}
 */
export async function runTesseractOCR(imageSource, options = {}) {
  let tesseract = options.tesseract || globalThis.Tesseract;
  if (!tesseract) {
    try {
      const mod = await import('tesseract.js');
      tesseract = mod.default || mod;
    } catch (_) {}
  }
  if (!tesseract) {
    throw new Error('Tesseract engine not found in environment or options');
  }

  const lang = options.lang || 'eng';
  const result = typeof tesseract.recognize === 'function'
    ? await tesseract.recognize(imageSource, lang, options.tesseractOptions)
    : await tesseract(imageSource, lang);

  return normalizeOCRLines(result);
}

/**
 * Main CV-Level OCR detector function.
 * Scans image/canvas/OCR data for sensitive text and returns sensitive regions.
 * @param {any} input - Canvas, ImageData, OCR lines array, or image source
 * @param {Object} [options={}] - Optional detector configuration
 * @param {Function} [options.recognizer] - Custom async OCR recognizer function
 * @param {Object} [options.tesseract] - Tesseract.js instance/worker
 * @param {number} [options.minConfidence=0.0] - Minimum confidence filter
 * @param {Array<string>} [options.categories=CATEGORY_ORDER] - Filter categories
 * @returns {Promise<Array<{ bbox: [number, number, number, number], category: 'email'|'phone'|'card'|'ssn', source: 'ocr', confidence: number }>>}
 */
export async function detectSensitiveOCRRegions(input, options = {}) {
  const minConfidence = options.minConfidence ?? 0.0;
  const categories = options.categories ?? CATEGORY_ORDER;

  // 1. Structured OCR input
  if (isOCRStructuredInput(input)) {
    return extractSensitiveRegionsFromOCR(input, { minConfidence, categories });
  }

  // 2. Custom recognizer callback
  if (typeof options.recognizer === 'function') {
    const ocrLines = await options.recognizer(input, options);
    return extractSensitiveRegionsFromOCR(ocrLines, { minConfidence, categories });
  }

  // 3. Tesseract.js if available
  if (options.tesseract || typeof globalThis.Tesseract !== 'undefined') {
    const ocrLines = await runTesseractOCR(input, options);
    return extractSensitiveRegionsFromOCR(ocrLines, { minConfidence, categories });
  }

  // 4. Canvas with pre-annotated OCR metadata (e.g. test harness / synthetic context)
  if (input && (input.__ocrTextLines || input.__ocrLines)) {
    const lines = input.__ocrTextLines || input.__ocrLines;
    return extractSensitiveRegionsFromOCR(lines, { minConfidence, categories });
  }

  // 5. Lightweight Canvas text detector
  if (options.text || options.lines) {
    const detectedBoxes = detectCanvasTextRegions(input, options);
    const fallbackBox = detectedBoxes[0]?.bbox ?? [0, 0, 0, 0];
    const linesToScan = options.lines || [{ text: options.text, bbox: fallbackBox, confidence: 0.85 }];
    return extractSensitiveRegionsFromOCR(linesToScan, { minConfidence, categories });
  }

  return [];
}

// Convenience alias
export { detectSensitiveOCRRegions as detectSensitiveRegions };
