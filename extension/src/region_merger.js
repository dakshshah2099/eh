/**
 * @fileoverview Sensitive Region Merger for Privacy Lens Agent.
 * Ticket 13 — Pure function to merge DOM (10), Face (11), and OCR (12) sensitive regions.
 * 
 * Features:
 * - Deduplicates overlapping bounding boxes using IoU and containment thresholds.
 * - Merges overlapping regions taking the union bounding box.
 * - Resolves category hierarchy/priority (e.g. password > card > ssn > email > phone > face).
 * - Combines detection sources (e.g. 'dom+ocr', 'dom+face', etc.).
 * - Adjusts corroborating confidence scores.
 * - Returns a clean, deterministic, sorted array of sensitive regions.
 */

/**
 * Standard priority order for sensitive categories.
 * Password / credentials have highest risk, followed by financial (pin, otp, card),
 * identity (ssn, tax), contact information (email, phone), and biometric (face).
 */
export const DEFAULT_CATEGORY_PRIORITY = [
  'password',
  'pin',
  'otp',
  'card',
  'ssn',
  'tax',
  'email',
  'phone',
  'face'
];

/**
 * Canonical ordering for combining sources.
 */
export const DEFAULT_SOURCE_ORDER = ['dom', 'ocr', 'face', 'cv'];

/**
 * Normalizes bounding box representation to [x, y, w, h] integers.
 * Handles arrays [x,y,w,h], or objects with {x,y,w,h}, {x,y,width,height},
 * {left,top,width,height}, or {x0,y0,x1,y1}.
 * 
 * @param {Array<number>|Object} bbox
 * @returns {[number, number, number, number]|null}
 */
export function normalizeBBox(bbox) {
  if (!bbox) return null;

  if (Array.isArray(bbox) && bbox.length >= 4) {
    const x = Math.round(Number(bbox[0]) || 0);
    const y = Math.round(Number(bbox[1]) || 0);
    const w = Math.max(0, Math.round(Number(bbox[2]) || 0));
    const h = Math.max(0, Math.round(Number(bbox[3]) || 0));
    return [x, y, w, h];
  }

  if (typeof bbox === 'object') {
    if (typeof bbox.x0 === 'number' && typeof bbox.x1 === 'number') {
      const x0 = Number(bbox.x0) || 0;
      const x1 = Number(bbox.x1) || 0;
      const y0 = Number(bbox.y0 ?? 0) || 0;
      const y1 = Number(bbox.y1 ?? 0) || 0;
      const minX = Math.min(x0, x1);
      const minY = Math.min(y0, y1);
      const w = Math.max(0, Math.abs(x1 - x0));
      const h = Math.max(0, Math.abs(y1 - y0));
      return [Math.round(minX), Math.round(minY), Math.round(w), Math.round(h)];
    }

    const x = Math.round(Number(bbox.x ?? bbox.left ?? 0) || 0);
    const y = Math.round(Number(bbox.y ?? bbox.top ?? 0) || 0);
    const w = Math.max(0, Math.round(Number(bbox.w ?? bbox.width ?? 0) || 0));
    const h = Math.max(0, Math.round(Number(bbox.h ?? bbox.height ?? 0) || 0));
    return [x, y, w, h];
  }

  return null;
}

/**
 * Computes overlap metrics between two bounding boxes:
 * - intersection area
 * - union area
 * - Intersection-over-Union (IoU)
 * - containment ratio (intersection / min(areaA, areaB))
 * 
 * @param {[number, number, number, number]} boxA
 * @param {[number, number, number, number]} boxB
 * @returns {{ intersectionArea: number, unionArea: number, iou: number, containment: number }}
 */
export function computeBBoxMetrics(boxA, boxB) {
  const [x1, y1, w1, h1] = boxA;
  const [x2, y2, w2, h2] = boxB;

  const areaA = Math.max(0, w1) * Math.max(0, h1);
  const areaB = Math.max(0, w2) * Math.max(0, h2);

  if (areaA === 0 || areaB === 0) {
    return { intersectionArea: 0, unionArea: areaA + areaB, iou: 0, containment: 0 };
  }

  const interX0 = Math.max(x1, x2);
  const interY0 = Math.max(y1, y2);
  const interX1 = Math.min(x1 + w1, x2 + w2);
  const interY1 = Math.min(y1 + h1, y2 + h2);

  const interW = Math.max(0, interX1 - interX0);
  const interH = Math.max(0, interY1 - interY0);
  const intersectionArea = interW * interH;

  const unionArea = areaA + areaB - intersectionArea;
  const iou = unionArea > 0 ? intersectionArea / unionArea : 0;
  const minArea = Math.min(areaA, areaB);
  const containment = minArea > 0 ? intersectionArea / minArea : 0;

  return { intersectionArea, unionArea, iou, containment };
}

/**
 * Determines whether two regions should merge based on IoU and containment thresholds.
 * 
 * @param {[number, number, number, number]} boxA
 * @param {[number, number, number, number]} boxB
 * @param {Object} [options]
 * @param {number} [options.iouThreshold=0.3]
 * @param {number} [options.containmentThreshold=0.8]
 * @returns {boolean}
 */
export function shouldMerge(boxA, boxB, options = {}) {
  const iouThreshold = options.iouThreshold ?? 0.3;
  const containmentThreshold = options.containmentThreshold ?? 0.8;
  const metrics = computeBBoxMetrics(boxA, boxB);
  return metrics.iou >= iouThreshold || metrics.containment >= containmentThreshold;
}

/**
 * Computes the union bounding box enclosing two boxes.
 * 
 * @param {[number, number, number, number]} boxA
 * @param {[number, number, number, number]} boxB
 * @returns {[number, number, number, number]}
 */
export function computeUnionBBox(boxA, boxB) {
  const [x1, y1, w1, h1] = boxA;
  const [x2, y2, w2, h2] = boxB;

  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const maxX = Math.max(x1 + w1, x2 + w2);
  const maxY = Math.max(y1 + h1, y2 + h2);

  return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
}

/**
 * Computes the union bounding box enclosing an arbitrary list of boxes.
 * 
 * @param {Array<[number, number, number, number]>} boxes
 * @returns {[number, number, number, number]}
 */
export function computeEnclosingBBox(boxes) {
  if (!boxes || boxes.length === 0) return [0, 0, 0, 0];
  let [minX, minY, w, h] = boxes[0];
  let maxX = minX + w;
  let maxY = minY + h;

  for (let i = 1; i < boxes.length; i++) {
    const [x, y, bw, bh] = boxes[i];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + bw);
    maxY = Math.max(maxY, y + bh);
  }

  return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
}

/**
 * Resolves the winning category among a list of candidates according to hierarchy priority.
 * 
 * @param {Array<string>} categories
 * @param {Array<string>} [priorityList=DEFAULT_CATEGORY_PRIORITY]
 * @returns {string}
 */
export function resolveCategory(categories, priorityList = DEFAULT_CATEGORY_PRIORITY) {
  const candidates = (Array.isArray(categories) ? categories : [categories])
    .filter(Boolean)
    .map(c => String(c).toLowerCase().trim());

  if (candidates.length === 0) return 'unknown';
  if (candidates.length === 1) return candidates[0];

  let bestCat = candidates[0];
  let bestIdx = priorityList.indexOf(bestCat);
  if (bestIdx === -1) bestIdx = Infinity;

  for (let i = 1; i < candidates.length; i++) {
    const cat = candidates[i];
    let idx = priorityList.indexOf(cat);
    if (idx === -1) idx = Infinity;
    if (idx < bestIdx) {
      bestIdx = idx;
      bestCat = cat;
    }
  }

  return bestCat;
}

/**
 * Combines detection source strings into a deduplicated, canonical string ('dom+ocr', etc.).
 * 
 * @param {Array<string>} sources
 * @param {Array<string>} [canonicalOrder=DEFAULT_SOURCE_ORDER]
 * @returns {string}
 */
export function combineSources(sources, canonicalOrder = DEFAULT_SOURCE_ORDER) {
  const tokens = new Set();
  const list = Array.isArray(sources) ? sources : [sources];

  for (const src of list) {
    if (typeof src === 'string') {
      src
        .split('+')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .forEach(s => tokens.add(s));
    }
  }

  if (tokens.size === 0) return 'unknown';

  const sorted = Array.from(tokens).sort((a, b) => {
    let idxA = canonicalOrder.indexOf(a);
    let idxB = canonicalOrder.indexOf(b);
    if (idxA === -1) idxA = 999;
    if (idxB === -1) idxB = 999;
    if (idxA !== idxB) return idxA - idxB;
    return a.localeCompare(b);
  });

  return sorted.join('+');
}

/**
 * Combines multiple confidence scores using the configured strategy.
 * Default: probabilistic independent corroboration: 1 - prod(1 - c_i).
 * 
 * @param {Array<number>} confidences
 * @param {Object} [options]
 * @param {string} [options.confidenceStrategy='probabilistic'] 'probabilistic' | 'max' | 'average'
 * @returns {number} Normalized confidence between 0.0 and 1.0 (rounded to 4 decimal places).
 */
export function combineConfidences(confidences, options = {}) {
  const vals = (Array.isArray(confidences) ? confidences : [confidences])
    .map(c => Number(c))
    .filter(c => !isNaN(c))
    .map(c => Math.max(0, Math.min(1, c)));

  if (vals.length === 0) return 1.0;
  if (vals.length === 1) return Number(vals[0].toFixed(4));

  const strategy = options.confidenceStrategy || 'probabilistic';

  let result;
  if (strategy === 'max') {
    result = Math.max(...vals);
  } else if (strategy === 'average') {
    const sum = vals.reduce((acc, v) => acc + v, 0);
    result = sum / vals.length;
  } else {
    // 'probabilistic' (default)
    let prodUncertainty = 1.0;
    for (const v of vals) {
      prodUncertainty *= (1.0 - v);
    }
    result = 1.0 - prodUncertainty;
  }

  return Number(Math.max(0, Math.min(1, result)).toFixed(4));
}

/**
 * Normalizes an incoming region object into an internal candidate.
 * 
 * @param {Object} item
 * @param {string} defaultSource
 * @returns {Object|null}
 */
function normalizeRegionItem(item, defaultSource = 'unknown') {
  if (!item || typeof item !== 'object') return null;

  const bbox = normalizeBBox(item.bbox);
  if (!bbox) return null;

  // Filter out degenerate regions with 0 width or height
  if (bbox[2] <= 0 || bbox[3] <= 0) return null;

  const category = String(item.category || 'unknown').toLowerCase().trim();
  const source = String(item.source || defaultSource || 'unknown').toLowerCase().trim();
  const confidence = typeof item.confidence === 'number' && !isNaN(item.confidence)
    ? Math.max(0, Math.min(1, item.confidence))
    : 1.0;

  return {
    bbox,
    category,
    source,
    confidence,
    extra: item
  };
}

/**
 * Merges a cluster of overlapping regions into a single consolidated region.
 * 
 * @param {Array<Object>} cluster
 * @param {Object} options
 * @returns {Object}
 */
function mergeCluster(cluster, options) {
  if (cluster.length === 1) {
    const single = cluster[0];
    const out = {
      bbox: single.bbox,
      category: single.category,
      source: single.source,
      confidence: single.confidence
    };
    if (options.preserveExtraFields && single.extra) {
      Object.assign(out, single.extra, {
        bbox: single.bbox,
        category: single.category,
        source: single.source,
        confidence: single.confidence
      });
    }
    return out;
  }

  const priorityList = options.categoryPriority || options.categoryHierarchy || DEFAULT_CATEGORY_PRIORITY;
  const canonicalSources = options.sourceOrder || DEFAULT_SOURCE_ORDER;

  const mergedBBox = computeEnclosingBBox(cluster.map(c => c.bbox));
  const mergedCategory = resolveCategory(cluster.map(c => c.category), priorityList);
  const mergedSource = combineSources(cluster.map(c => c.source), canonicalSources);
  const mergedConfidence = combineConfidences(cluster.map(c => c.confidence), options);

  const merged = {
    bbox: mergedBBox,
    category: mergedCategory,
    source: mergedSource,
    confidence: mergedConfidence
  };

  if (options.preserveExtraFields) {
    // Preserve selectors if any item in cluster has selector
    const selectorItem = cluster.find(c => c.selector || c.extra?.selector);
    if (selectorItem) {
      merged.selector = selectorItem.selector || selectorItem.extra?.selector;
      merged.extra = { ...(selectorItem.extra || {}), selector: merged.selector };
    }
  }

  return merged;
}

/**
 * Clusters overlapping regions using connected components.
 * 
 * @param {Array<Object>} items
 * @param {Object} options
 * @returns {Array<Array<Object>>}
 */
function clusterOverlappingRegions(items, options) {
  const n = items.length;
  if (n <= 1) return items.map(it => [it]);

  // Disjoint Set Union (DSU)
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    let root = i;
    while (root !== parent[root]) root = parent[root];
    let curr = i;
    while (curr !== root) {
      const next = parent[curr];
      parent[curr] = root;
      curr = next;
    }
    return root;
  }
  function union(i, j) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (shouldMerge(items[i].bbox, items[j].bbox, options)) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }

  return Array.from(groups.values());
}

/**
 * Pure function to merge sensitive regions from DOM (10), Face (11), and OCR (12).
 * Deduplicates overlapping bounding boxes using IoU and containment thresholds.
 * 
 * @param {Array<Object>} [domRegions=[]] Sensitive regions from DOM detector (Ticket 10).
 * @param {Array<Object>|Object} [faceRegions=[]] Sensitive regions from CV Face detector (Ticket 11) or options object if called with 2 args.
 * @param {Array<Object>} [ocrRegions=[]] Sensitive regions from OCR detector (Ticket 12).
 * @param {Object} [options={}] Configuration options:
 *   - iouThreshold {number} [0.3]: Minimum IoU to trigger deduplication.
 *   - containmentThreshold {number} [0.8]: Minimum containment ratio to trigger deduplication.
 *   - categoryPriority {Array<string>}: Custom category hierarchy list.
 *   - confidenceStrategy {'probabilistic'|'max'|'average'} ['probabilistic']: Score combination mode.
 *   - sortBy {'reading-order'|'confidence'|'category'|'none'} ['reading-order']: Output sort order.
 *   - preserveExtraFields {boolean} [false]: Whether to retain extra properties like selector.
 * @returns {Array<{ bbox: [number, number, number, number], category: string, source: string, confidence: number }>} Clean sorted regions.
 */
export function mergeSensitiveRegions(domRegions = [], faceRegions = [], ocrRegions = [], options = {}) {
  // Support flexible call signatures:
  // 1) mergeSensitiveRegions(allRegions, options)
  // 2) mergeSensitiveRegions(domRegions, faceRegions, ocrRegions, options)
  let domList = domRegions;
  let faceList = faceRegions;
  let ocrList = ocrRegions;
  let opts = options;

  if (faceRegions && !Array.isArray(faceRegions) && typeof faceRegions === 'object' && ocrRegions === undefined) {
    opts = faceRegions;
    faceList = [];
    ocrList = [];
  } else if (!Array.isArray(domList) && typeof domList === 'object' && domList !== null) {
    // If wrapped in an object like { domRegions, faceRegions, ocrRegions, options }
    const wrapper = domList;
    domList = wrapper.domRegions || wrapper.dom || [];
    faceList = wrapper.faceRegions || wrapper.face || wrapper.cv || [];
    ocrList = wrapper.ocrRegions || wrapper.ocr || [];
    opts = wrapper.options || {};
  }

  opts = opts || {};
  domList = Array.isArray(domList) ? domList : [];
  faceList = Array.isArray(faceList) ? faceList : [];
  ocrList = Array.isArray(ocrList) ? ocrList : [];

  // Normalize all regions and record default source
  const candidates = [];

  for (const item of domList) {
    const norm = normalizeRegionItem(item, 'dom');
    if (norm) candidates.push(norm);
  }
  for (const item of faceList) {
    const norm = normalizeRegionItem(item, 'face');
    if (norm) candidates.push(norm);
  }
  for (const item of ocrList) {
    const norm = normalizeRegionItem(item, 'ocr');
    if (norm) candidates.push(norm);
  }

  if (candidates.length === 0) {
    return [];
  }

  // Iterative clustering passes until convergence (handles cascaded union expansions)
  let currentItems = candidates;
  let changed = true;
  let iterations = 0;
  const maxIterations = 10;

  while (changed && iterations < maxIterations) {
    iterations++;
    const clusters = clusterOverlappingRegions(currentItems, opts);
    const mergedList = clusters.map(cluster => mergeCluster(cluster, opts));

    if (mergedList.length === currentItems.length) {
      changed = false;
      currentItems = mergedList.map(m => normalizeRegionItem(m, m.source));
    } else {
      currentItems = mergedList.map(m => normalizeRegionItem(m, m.source));
    }
  }

  // Extract clean results
  const result = currentItems.map(item => {
    const entry = {
      bbox: item.bbox,
      category: item.category,
      source: item.source,
      confidence: item.confidence
    };
    if (opts.preserveExtraFields && (item.selector || item.extra?.selector)) {
      entry.selector = item.selector || item.extra.selector;
    }
    return entry;
  });

  // Sort results
  const sortBy = opts.sortBy || 'reading-order';
  const priorityList = opts.categoryPriority || opts.categoryHierarchy || DEFAULT_CATEGORY_PRIORITY;

  if (sortBy === 'reading-order') {
    // Top-to-bottom (y asc), then left-to-right (x asc)
    result.sort((a, b) => {
      if (a.bbox[1] !== b.bbox[1]) {
        return a.bbox[1] - b.bbox[1];
      }
      return a.bbox[0] - b.bbox[0];
    });
  } else if (sortBy === 'confidence') {
    result.sort((a, b) => b.confidence - a.confidence);
  } else if (sortBy === 'category') {
    result.sort((a, b) => {
      let idxA = priorityList.indexOf(a.category);
      let idxB = priorityList.indexOf(b.category);
      if (idxA === -1) idxA = Infinity;
      if (idxB === -1) idxB = Infinity;
      return idxA - idxB;
    });
  }

  return result;
}
