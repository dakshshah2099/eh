/**
 * @fileoverview DOM Text Substitution for Privacy Lens Agent.
 * Ticket 15 — Pure function to redact sensitive DOM elements and text.
 *
 * Traverses extracted DOM skeleton JSON and replaces sensitive content
 * (textContent, value, placeholder, aria-label, etc.) with typed tokens:
 * - [REDACTED_PASSWORD]
 * - [REDACTED_EMAIL]
 * - [REDACTED_CARD]
 * - [REDACTED_SSN]
 * - [REDACTED_PHONE]
 * - [REDACTED_NAME]
 * - [REDACTED_PII]
 *
 * Ensures no raw sensitive text remains in the cloned/mutated DOM skeleton.
 */

import { evaluateElementSensitivity, normalizeBBox as domNormalizeBBox } from './dom_detector.js';

/**
 * Standard typed redaction tokens.
 */
export const REDACTION_TOKENS = {
  PASSWORD: '[REDACTED_PASSWORD]',
  EMAIL: '[REDACTED_EMAIL]',
  CARD: '[REDACTED_CARD]',
  SSN: '[REDACTED_SSN]',
  PHONE: '[REDACTED_PHONE]',
  NAME: '[REDACTED_NAME]',
  PII: '[REDACTED_PII]'
};

/**
 * Category to redaction token mapping.
 */
export const DEFAULT_CATEGORY_TOKEN_MAP = {
  password: REDACTION_TOKENS.PASSWORD,
  passwd: REDACTION_TOKENS.PASSWORD,
  pwd: REDACTION_TOKENS.PASSWORD,
  passcode: REDACTION_TOKENS.PASSWORD,
  secret: REDACTION_TOKENS.PASSWORD,

  email: REDACTION_TOKENS.EMAIL,

  card: REDACTION_TOKENS.CARD,
  creditcard: REDACTION_TOKENS.CARD,
  credit_card: REDACTION_TOKENS.CARD,
  cvv: REDACTION_TOKENS.CARD,
  cvc: REDACTION_TOKENS.CARD,
  pan: REDACTION_TOKENS.CARD,

  ssn: REDACTION_TOKENS.SSN,
  social: REDACTION_TOKENS.SSN,
  social_security: REDACTION_TOKENS.SSN,
  tax: REDACTION_TOKENS.SSN,

  phone: REDACTION_TOKENS.PHONE,
  tel: REDACTION_TOKENS.PHONE,
  telephone: REDACTION_TOKENS.PHONE,
  mobile: REDACTION_TOKENS.PHONE,

  name: REDACTION_TOKENS.NAME,
  fullname: REDACTION_TOKENS.NAME,
  firstname: REDACTION_TOKENS.NAME,
  lastname: REDACTION_TOKENS.NAME,
  face: REDACTION_TOKENS.NAME,

  pin: REDACTION_TOKENS.PII,
  otp: REDACTION_TOKENS.PII,
  pii: REDACTION_TOKENS.PII,
  default: REDACTION_TOKENS.PII
};

/**
 * Priority order for category conflicts.
 * Highest priority wins when multiple sensitive regions match an element.
 */
export const DEFAULT_CATEGORY_PRIORITY = [
  'password',
  'card',
  'pin',
  'otp',
  'ssn',
  'tax',
  'email',
  'phone',
  'name',
  'face',
  'pii'
];

/**
 * Standard regex patterns for detecting and substituting raw PII in string content.
 */
export const SENSITIVE_TEXT_PATTERNS = [
  {
    category: 'card',
    regex: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
    token: REDACTION_TOKENS.CARD
  },
  {
    category: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    token: REDACTION_TOKENS.SSN
  },
  {
    category: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    token: REDACTION_TOKENS.EMAIL
  },
  {
    category: 'phone',
    regex: /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    token: REDACTION_TOKENS.PHONE
  }
];

/**
 * Normalizes bounding box representation to [x, y, w, h] integers.
 *
 * @param {Array<number>|Object|null} bbox
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
 * Checks whether two bounding boxes overlap.
 *
 * @param {Array<number>|Object} bboxA
 * @param {Array<number>|Object} bboxB
 * @param {number} [minOverlap=0] - Minimum intersection ratio relative to smaller box
 * @returns {boolean}
 */
export function checkBBoxOverlap(bboxA, bboxB, minOverlap = 0) {
  const normA = normalizeBBox(bboxA);
  const normB = normalizeBBox(bboxB);
  if (!normA || !normB) return false;

  const [x1, y1, w1, h1] = normA;
  const [x2, y2, w2, h2] = normB;
  if (w1 <= 0 || h1 <= 0 || w2 <= 0 || h2 <= 0) return false;

  const ix0 = Math.max(x1, x2);
  const iy0 = Math.max(y1, y2);
  const ix1 = Math.min(x1 + w1, x2 + w2);
  const iy1 = Math.min(y1 + h1, y2 + h2);

  const iw = Math.max(0, ix1 - ix0);
  const ih = Math.max(0, iy1 - iy0);
  const intersectionArea = iw * ih;

  if (intersectionArea <= 0) return false;
  if (minOverlap <= 0) return true;

  const areaA = w1 * h1;
  const areaB = w2 * h2;
  const minArea = Math.min(areaA, areaB);
  return (intersectionArea / minArea) >= minOverlap;
}

/**
 * Resolves typed redaction token for a given category.
 *
 * @param {string} category
 * @param {Object} [options={}]
 * @returns {string} Redaction token
 */
export function getRedactionToken(category, options = {}) {
  const map = { ...DEFAULT_CATEGORY_TOKEN_MAP, ...(options.tokenMap || options.tokens || {}) };
  const cat = String(category || '').toLowerCase().trim();
  return map[cat] || map.default || REDACTION_TOKENS.PII;
}

/**
 * Deep clones an object using structuredClone if available, otherwise JSON parsing.
 *
 * @param {*} value
 * @returns {*} Cloned copy
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (_) {
      // Fallback if value contains non-cloneable members
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Canonical URL path prefixes that precede a personal/user identifier slug.
 */
export const USER_PATH_PREFIX_REGEX = /(\/(?:in|user|users|profile|u|author|c|member|people)\/)([a-zA-Z0-9._-]+)/gi;

/**
 * Tilde user home directories in URLs (e.g. /~daksh or /~daksh/).
 */
export const TILDE_PATH_REGEX = /(\/~)([a-zA-Z0-9._-]+)/gi;

/**
 * Query parameter keys that identify personal users (e.g. ?user=daksh or &author=daksh).
 */
export const USER_QUERY_PARAM_REGEX = /([?&](?:u|user|username|name|profile|author)=)([^&#]+)/gi;

/**
 * Sanitizes a URL string by redacting ONLY user identifier slugs while strictly
 * preserving URL hierarchy, protocol, hostname, surrounding path segments, and other query params.
 *
 * @param {string} urlStr - Raw URL string
 * @param {string[]} [explicitNames=[]] - Discovered candidate personal names
 * @returns {string} Redacted URL string
 */
export function redactUrlSlug(urlStr, explicitNames = []) {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;

  let redacted = urlStr;

  // 1. Redact canonical user path segments: /in/username -> /in/[REDACTED_NAME]
  redacted = redacted.replace(USER_PATH_PREFIX_REGEX, '$1[REDACTED_NAME]');

  // 2. Redact tilde personal directory slugs: /~username -> /~[REDACTED_NAME]
  redacted = redacted.replace(TILDE_PATH_REGEX, '$1[REDACTED_NAME]');

  // 3. Redact identity query parameter values: ?user=username -> ?user=[REDACTED_NAME]
  redacted = redacted.replace(USER_QUERY_PARAM_REGEX, '$1[REDACTED_NAME]');

  // 4. Redact explicit name slugs if matching segments in URL path
  if (Array.isArray(explicitNames) && explicitNames.length > 0) {
    for (const name of explicitNames) {
      if (!name || typeof name !== 'string') continue;
      const cleanName = name.trim();
      if (cleanName.length < 3) continue;

      const lower = cleanName.toLowerCase();
      const slugDash = lower.replace(/\s+/g, '-');
      const slugUnderscore = lower.replace(/\s+/g, '_');
      const slugCompact = lower.replace(/[^a-z0-9]/g, '');

      const slugsToMatch = new Set([slugDash, slugUnderscore, slugCompact]);
      const parts = cleanName.split(/\s+/);
      if (parts.length > 1 && parts[0].length >= 4) {
        slugsToMatch.add(parts[0].toLowerCase());
      }

      for (const slug of slugsToMatch) {
        if (!slug || slug.length < 3) continue;
        const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const segRegex = new RegExp(`(/)${escaped}(/|\\?|#|$)`, 'gi');
        redacted = redacted.replace(segRegex, '$1[REDACTED_NAME]$2');
      }
    }
  }

  return redacted;
}

/**
 * Scans a text string and replaces any occurrences of raw PII with typed tokens.
 *
 * @param {string} text - Raw input string
 * @param {Object} [options={}] - Options and custom patterns
 * @returns {string} Redacted string
 */
export function redactTextContent(text, options = {}) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  // Avoid re-redacting pure tokens
  const allTokens = Object.values(REDACTION_TOKENS);
  if (allTokens.includes(text.trim())) {
    return text;
  }

  let redacted = text;

  // 1. Explicit text items from sensitive regions (e.g. OCR text, user names)
  const explicitItems = [];
  if (Array.isArray(options.explicitTexts)) {
    for (const item of options.explicitTexts) {
      if (typeof item === 'string' && item.trim()) {
        explicitItems.push({ text: item.trim(), category: 'name' });
      } else if (item && typeof item.text === 'string' && item.text.trim()) {
        explicitItems.push({ text: item.text.trim(), category: item.category || 'name' });
      }
    }
  }
  if (Array.isArray(options.names)) {
    for (const name of options.names) {
      if (typeof name === 'string' && name.trim()) {
        explicitItems.push({ text: name.trim(), category: 'name' });
      }
    }
  }

  for (const item of explicitItems) {
    const token = getRedactionToken(item.category, options);
    const escaped = item.text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    redacted = redacted.replace(re, token);
  }

  // 2. Custom patterns from options
  if (Array.isArray(options.customPatterns)) {
    for (const p of options.customPatterns) {
      if (p && p.regex instanceof RegExp) {
        const token = p.token || getRedactionToken(p.category, options);
        redacted = redacted.replace(p.regex, token);
      }
    }
  }

  // 3. Standard PII patterns (card, ssn, email, phone)
  for (const { regex, token, category } of SENSITIVE_TEXT_PATTERNS) {
    if (options.disabledCategories && options.disabledCategories.includes(category)) {
      continue;
    }
    const resolvedToken = (options.tokenMap && options.tokenMap[category]) ? options.tokenMap[category] : token;
    regex.lastIndex = 0;
    redacted = redacted.replace(regex, resolvedToken);
  }

  // 4. Redact URL slugs embedded in text
  const nameStrings = explicitItems.filter(i => i.category === 'name').map(i => i.text);
  redacted = redactUrlSlug(redacted, nameStrings);

  return redacted;
}

/**
 * Finds matching sensitive regions for a given DOM skeleton node.
 *
 * @param {Object} node - Skeleton element node
 * @param {Array<Object>} regions - Normalized sensitive regions
 * @param {Object} options - Matching options
 * @returns {Object|null} Best matching sensitive region or null
 */
function findMatchingSensitiveRegion(node, regions, options) {
  if (!node || !Array.isArray(regions) || regions.length === 0) {
    return null;
  }

  const matches = [];

  for (const region of regions) {
    let matched = false;

    // 1. Selector match
    if (region.selector) {
      if (node.selector && node.selector === region.selector) {
        matched = true;
      } else if (node.id && (region.selector === `#${node.id}` || region.selector === node.id)) {
        matched = true;
      }
    }

    // 2. ID match
    if (!matched && region.id && node.id && region.id === node.id) {
      matched = true;
    }

    // 3. Bounding box overlap match
    if (!matched && region.bbox && node.bbox) {
      const minOverlap = options.minOverlapThreshold ?? 0;
      if (checkBBoxOverlap(node.bbox, region.bbox, minOverlap)) {
        matched = true;
      }
    }

    if (matched) {
      matches.push(region);
    }
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    return matches[0];
  }

  // Resolve conflicts using category priority order, then confidence
  const priorityOrder = options.categoryPriority || DEFAULT_CATEGORY_PRIORITY;

  matches.sort((a, b) => {
    const catA = String(a.category || '').toLowerCase();
    const catB = String(b.category || '').toLowerCase();
    const idxA = priorityOrder.indexOf(catA);
    const idxB = priorityOrder.indexOf(catB);
    const pA = idxA >= 0 ? idxA : 999;
    const pB = idxB >= 0 ? idxB : 999;

    if (pA !== pB) return pA - pB;
    return (b.confidence ?? 1.0) - (a.confidence ?? 1.0);
  });

  return matches[0];
}

/**
 * Text and content attributes on DOM skeleton nodes that may contain sensitive data.
 */
const CONTENT_FIELDS = [
  'value',
  'text',
  'textContent',
  'innerText',
  'placeholder',
  'ariaLabel',
  'aria-label',
  'aria_label',
  'title',
  'alt',
  'label',
  'labelText',
  'content'
];

/**
 * Redacts a single DOM skeleton node.
 *
 * @param {Object} node - Skeleton node to redact
 * @param {Array<Object>} regions - Normalized sensitive regions
 * @param {Object} options - Redaction options
 */
function redactSingleNode(node, regions, options) {
  if (!node || typeof node !== 'object') {
    return;
  }

  // 1. Check if node matches any sensitive region
  const matchingRegion = findMatchingSensitiveRegion(node, regions, options);

  // 2. Check intrinsic sensitivity (e.g. type="password", autocomplete="cc-number")
  let intrinsicDetection = null;
  if (!matchingRegion && options.checkIntrinsicSensitivity !== false) {
    if (node.category) {
      intrinsicDetection = { category: node.category };
    } else {
      intrinsicDetection = evaluateElementSensitivity(node, options);
    }
  }

  const effectiveCategory = matchingRegion?.category || intrinsicDetection?.category || null;

  if (effectiveCategory) {
    const token = getRedactionToken(effectiveCategory, options);

    const isInput = node.tag === 'input' || node.tag === 'textarea';

    // Replace all applicable text, value, and label fields
    for (const field of CONTENT_FIELDS) {
      if (node[field] !== undefined && node[field] !== null) {
        if (typeof node[field] === 'string' && node[field].length > 0) {
          if (matchingRegion || isInput || field === 'value') {
            node[field] = token;
          } else {
            // For non-input elements without matchingRegion, redact sensitive patterns while preserving surrounding text
            const redacted = redactTextContent(node[field], options);
            node[field] = (redacted !== node[field]) ? redacted : token;
          }
        } else if (typeof node[field] === 'string' && field === 'value') {
          // If value is empty string on a sensitive field (like password input), also assign token if requested or populated
          node[field] = token;
        }
      }
    }

    // Ensure value is set to token if input is sensitive even if value was undefined/null
    if (isInput && node.value !== undefined) {
      node.value = token;
    }
  } else if (options.scanTextPatterns !== false) {
    // Scan and redact any raw PII occurrences inside text/label/value fields
    for (const field of CONTENT_FIELDS) {
      if (typeof node[field] === 'string' && node[field].length > 0) {
        node[field] = redactTextContent(node[field], options);
      }
    }
  }

  // Sanitize user identifier slugs in URL attributes (href, src)
  const explicitNames = (options.names || []).concat(
    (options.explicitTexts || []).map(t => (typeof t === 'string' ? t : t?.text))
  ).filter(Boolean);

  if (typeof node.href === 'string' && node.href.length > 0) {
    node.href = redactUrlSlug(node.href, explicitNames);
  }
  if (typeof node.src === 'string' && node.src.length > 0) {
    node.src = redactUrlSlug(node.src, explicitNames);
  }

  // Recursively redact children
  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      redactSingleNode(node.children[i], regions, options);
    }
  }
}

/**
 * Pure function that mutates or returns a cloned DOM skeleton JSON where sensitive
 * text, values, placeholders, and aria-labels are replaced with typed tokens.
 *
 * @param {Object|Array|null} domSkeleton - DOM skeleton tree, array of elements, or envelope
 * @param {Array<Object>|Object} [sensitiveRegions=[]] - Sensitive regions from detectors/merger
 * @param {Object} [options={}] - Redaction configuration options
 * @param {boolean} [options.inPlace=false] - If true, mutates input in-place instead of cloning
 * @param {Object} [options.tokenMap={}] - Custom category to token mapping
 * @param {boolean} [options.scanTextPatterns=true] - Scans free text for raw PII regex patterns
 * @param {boolean} [options.checkIntrinsicSensitivity=true] - Detects inputs like type=password
 * @param {number} [options.minOverlapThreshold=0] - Overlap threshold for bbox intersection
 * @returns {Object|Array|null} Sanitized DOM skeleton
 */
export function redactDomSkeleton(domSkeleton, sensitiveRegions = [], options = {}) {
  if (!domSkeleton) {
    return domSkeleton;
  }

  // Clone by default to maintain pure function semantics unless inPlace is explicitly requested
  const target = options.inPlace === true ? domSkeleton : deepClone(domSkeleton);

  // Normalize sensitive regions
  const rawRegions = Array.isArray(sensitiveRegions)
    ? sensitiveRegions
    : (sensitiveRegions && typeof sensitiveRegions === 'object' ? [sensitiveRegions] : []);

  const normalizedRegions = [];
  const explicitTexts = [];

  for (const r of rawRegions) {
    if (!r || typeof r !== 'object') continue;
    const cat = String(r.category || 'pii').toLowerCase().trim();
    const entry = {
      bbox: normalizeBBox(r.bbox),
      category: cat,
      selector: r.selector || null,
      id: r.id || null,
      confidence: typeof r.confidence === 'number' ? r.confidence : 1.0,
      text: (typeof r.text === 'string' && r.text.trim()) ? r.text.trim() : null
    };
    normalizedRegions.push(entry);

    if (entry.text) {
      explicitTexts.push({ text: entry.text, category: entry.category });
    }
  }

  const explicitNames = (options.names || []).concat(
    (options.explicitTexts || []).map(t => (typeof t === 'string' ? t : t?.text))
  ).filter(Boolean);

  const effectiveOptions = {
    ...options,
    names: explicitNames,
    explicitTexts: [...explicitTexts, ...(options.explicitTexts || [])]
  };

  // Handle Envelope structures (e.g. { skeleton: ... }, { tree: ... }, { elements: [...] })
  if (!Array.isArray(target) && typeof target === 'object') {
    let handledEnvelope = false;

    if (target.skeleton && typeof target.skeleton === 'object') {
      redactDomSkeleton(target.skeleton, normalizedRegions, { ...effectiveOptions, inPlace: true });
      handledEnvelope = true;
    }
    if (target.tree && typeof target.tree === 'object' && target.tree !== target.skeleton) {
      redactDomSkeleton(target.tree, normalizedRegions, { ...effectiveOptions, inPlace: true });
      handledEnvelope = true;
    }
    if (Array.isArray(target.elements)) {
      for (const el of target.elements) {
        redactSingleNode(el, normalizedRegions, effectiveOptions);
      }
      handledEnvelope = true;
    }

    if (handledEnvelope) {
      return target;
    }
  }

  // Handle array of elements
  if (Array.isArray(target)) {
    for (const item of target) {
      redactSingleNode(item, normalizedRegions, effectiveOptions);
    }
    return target;
  }

  // Handle single node tree
  redactSingleNode(target, normalizedRegions, effectiveOptions);

  return target;
}
