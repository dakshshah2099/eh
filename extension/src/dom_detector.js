/**
 * @fileoverview DOM-Level Sensitive Element Detector.
 * Ticket 10 — Pure function scanner for DOM skeletons to flag sensitive elements.
 * 
 * Flags sensitive input and form elements based on:
 * - Password input types
 * - Sensitive autocomplete attributes (cc-*, email, tel)
 * - Semantic input types (email, tel, and number when named/labeled card or pin)
 * - Attribute regex matching (ssn, social, card, cvv, cvc, otp, pan, pin, password, secret, tax)
 * 
 * Returns array of:
 * [{ bbox: [x,y,w,h], category: string, source: 'dom', confidence: 1.0, selector: string }]
 */

/**
 * Standard sensitive categories.
 */
export const SENSITIVE_CATEGORIES = {
  PASSWORD: 'password',
  CARD: 'card',
  EMAIL: 'email',
  PHONE: 'phone',
  SSN: 'ssn',
  PIN: 'pin',
  OTP: 'otp',
  TAX: 'tax'
};

/**
 * Regex pattern for sensitive name, id, aria-label, and placeholder matching.
 * Matches: ssn|social|card|cvv|cvc|otp|pan|pin|password|secret|tax
 */
export const SENSITIVE_DOM_REGEX = /(?:ssn|social|card|cvv|cvc|otp|pan|pin|password|secret|tax)/i;

/**
 * Sensitive keyword set for tokenized boundary-safe matching.
 */
export const SENSITIVE_KEYWORDS = new Set([
  'ssn', 'social', 'card', 'cvv', 'cvc', 'otp', 'pan', 'pin',
  'password', 'passwd', 'pwd', 'passcode', 'secret', 'tax'
]);

/**
 * Structural, heading, and title tags that should not be classified as sensitive form fields.
 */
export const NON_SENSITIVE_STRUCTURAL_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'nav', 'footer', 'title', 'legend'
]);

/**
 * Autocomplete matching patterns:
 * - cc-*: credit card attributes (cc-number, cc-exp, cc-csc, cc-type, etc.)
 * - email: email address
 * - tel: telephone number and components
 * - name: personal names and components (W3C standard)
 */
export const AUTOCOMPLETE_PATTERNS = {
  CARD: /\bcc-[-a-z0-9]+/i,
  EMAIL: /\bemail\b/i,
  TEL: /\btel(?:-[-a-z0-9]+)?\b/i,
  NAME: /\b(?:name|given-name|family-name|additional-name|nickname)\b/i
};

/**
 * Regex patterns for standard personal name form inputs.
 */
export const FORM_NAME_FIELD_REGEX = /^(?:first[_-]?name|last[_-]?name|full[_-]?name|user[_-]?name|nickname|sur[_-]?name|family[_-]?name|given[_-]?name)$/i;
export const FORM_NAME_CONTAINS_REGEX = /(?:first[-_]?name|last[-_]?name|full[-_]?name)/i;

/**
 * Common non-personal UI terms to reject when extracting names from metadata/headings.
 */
export const GENERIC_UI_WORDS = new Set([
  'login', 'log in', 'signin', 'sign in', 'signup', 'sign up', 'register',
  'home', 'homepage', 'dashboard', 'settings', 'profile', 'user profile',
  'welcome', 'overview', 'search', 'notifications', 'messages', 'help',
  'privacy', 'terms', 'privacy policy', 'terms of service', 'about', 'contact',
  'cart', 'checkout', 'billing', 'shipping', 'order', 'feed', 'timeline'
]);

/**
 * Helper to check if a string looks like a legitimate personal name.
 * 2–4 capitalized words, 3 to 40 characters, not matching generic UI labels.
 *
 * @param {string} str
 * @returns {boolean}
 */
export function isValidPersonalName(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (trimmed.length < 3 || trimmed.length > 40) return false;
  if (GENERIC_UI_WORDS.has(trimmed.toLowerCase())) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  for (const w of words) {
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'. -]+$/.test(w)) return false;
    const firstChar = w[0];
    if (firstChar === firstChar.toLowerCase() && !['de', 'van', 'von', 'del', 'der', 'la', 'le', 'di'].includes(w.toLowerCase())) {
      return false;
    }
  }

  return true;
}

/**
 * Extracts personal identities from page-level semantic standards:
 * - JSON-LD Schema.org Person objects
 * - OpenGraph & standard meta tags (og:title, author)
 * - Microformats (rel="author", p-name, h-card, itemprop="name")
 *
 * @param {Object|Array} domSkeleton - Extracted DOM skeleton
 * @returns {string[]} Array of unique personal names
 */
export function extractSemanticIdentities(domSkeleton) {
  if (!domSkeleton) return [];

  const foundNames = new Set();

  function addCandidate(raw) {
    if (!raw || typeof raw !== 'string') return;
    const clean = raw.trim();
    if (isValidPersonalName(clean)) {
      foundNames.add(clean);
    }
  }

  // 1. Check page-level metadata if present
  const metadata = domSkeleton?.metadata || domSkeleton?.skeleton?.metadata || {};

  // 1a. JSON-LD Schema.org objects
  const ldJson = metadata.ldJson || [];
  function inspectLdNode(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) inspectLdNode(item);
      return;
    }

    const type = node['@type'];
    const isPerson = type === 'Person' || (Array.isArray(type) && type.includes('Person'));
    if (isPerson) {
      if (typeof node.name === 'string') addCandidate(node.name);
      if (typeof node.alternateName === 'string') addCandidate(node.alternateName);
      if (typeof node.givenName === 'string' && typeof node.familyName === 'string') {
        addCandidate(`${node.givenName} ${node.familyName}`);
      }
    }

    if (Array.isArray(node['@graph'])) {
      for (const item of node['@graph']) inspectLdNode(item);
    }
    if (node.author) inspectLdNode(node.author);
  }

  inspectLdNode(ldJson);

  // 1b. og:title and document title (strip trailing site branding)
  const titles = [metadata.ogTitle, metadata.title].filter(Boolean);
  for (const t of titles) {
    const candidate = t.split(/[|•–—\/-]/)[0]?.trim();
    if (candidate) addCandidate(candidate);
  }

  // 1c. Author meta tag
  if (metadata.author) {
    addCandidate(metadata.author);
  }

  // 2. Traverse DOM skeleton for Microformats and semantic author attributes
  function traverseDom(node) {
    if (!node || typeof node !== 'object') return;

    if (node.tag === 'script' && (node.type === 'application/ld+json' || node.id === 'ld-json')) {
      try {
        const parsed = JSON.parse(node.text || node.textContent || '{}');
        inspectLdNode(parsed);
      } catch (_) {}
    }

    const rel = String(node.rel || (node.getAttribute ? node.getAttribute('rel') : '') || '').toLowerCase();
    const className = String(node.className || node.class || '').toLowerCase();
    const itemprop = String(node.itemprop || (node.getAttribute ? node.getAttribute('itemprop') : '') || '').toLowerCase();
    const tag = String(node.tag || node.tagName || '').toLowerCase();

    const isAuthorRel = rel.includes('author');
    const isPName = className.includes('p-name') || className.includes('h-card');
    const isItempropName = itemprop === 'name';
    const isAddressTag = tag === 'address';

    if (isAuthorRel || isPName || isItempropName || isAddressTag) {
      const nodeText = (node.text || node.textContent || '').trim();
      if (nodeText) addCandidate(nodeText);
    }

    const children = node.children || node.elements || [];
    if (Array.isArray(children)) {
      for (const child of children) traverseDom(child);
    }
  }

  traverseDom(domSkeleton);

  return Array.from(foundNames);
}

/**
 * Correlates detected face/avatar regions with nearby heading elements (h1, h2, h3).
 *
 * @param {Array<Object>} faceRegions - Sensitive regions with category 'face'
 * @param {Object|Array} domSkeleton - DOM skeleton
 * @param {Object} [options={}]
 * @returns {Array<Object>} Sensitive regions for face-adjacent headings
 */
export function correlateFaceWithHeadings(faceRegions = [], domSkeleton, options = {}) {
  if (!Array.isArray(faceRegions) || faceRegions.length === 0 || !domSkeleton) {
    return [];
  }

  const results = [];
  const maxDistance = options.maxFaceDistance ?? 160;

  const headings = [];
  function collectHeadings(node) {
    if (!node || typeof node !== 'object') return;
    const tag = String(node.tag || node.tagName || '').toLowerCase();
    const role = String(node.role || '').toLowerCase();
    if (['h1', 'h2', 'h3'].includes(tag) || role === 'heading') {
      const text = (node.text || node.textContent || '').trim();
      const bbox = normalizeBBox(node.bbox, node);
      if (text && bbox[2] > 0 && bbox[3] > 0) {
        headings.push({ node, text, bbox, tag });
      }
    }
    const children = node.children || node.elements || [];
    if (Array.isArray(children)) {
      for (const child of children) collectHeadings(child);
    }
  }
  collectHeadings(domSkeleton);

  for (const face of faceRegions) {
    if (!face || !face.bbox) continue;
    const [fx, fy, fw, fh] = normalizeBBox(face.bbox);
    const faceCenterX = fx + fw / 2;
    const faceCenterY = fy + fh / 2;

    for (const h of headings) {
      const [hx, hy, hw, hh] = h.bbox;

      // Minimum edge-to-edge gap between face box and heading box
      const gapX = Math.max(0, Math.max(fx - (hx + hw), hx - (fx + fw)));
      const gapY = Math.max(0, Math.max(fy - (hy + hh), hy - (fy + fh)));
      const distance = Math.sqrt(gapX * gapX + gapY * gapY);

      if (distance <= maxDistance) {
        if (isValidPersonalName(h.text)) {
          results.push({
            bbox: h.bbox,
            category: 'name',
            source: 'dom+face',
            confidence: 0.95,
            selector: getSelectorForNode(h.node),
            text: h.text
          });
        }
      }
    }
  }

  return results;
}

/**
 * Normalizes bounding box into [x, y, w, h] array.
 *
 * @param {Array|Object|null} bbox - Bounding box representation
 * @param {Object} [el] - DOM element or node
 * @returns {[number, number, number, number]}
 */
export function normalizeBBox(bbox, el = null) {
  if (Array.isArray(bbox) && bbox.length >= 4) {
    return [
      Number(bbox[0]) || 0,
      Number(bbox[1]) || 0,
      Number(bbox[2]) || 0,
      Number(bbox[3]) || 0
    ];
  }

  if (bbox && typeof bbox === 'object') {
    const x = Number(bbox.x ?? bbox.left ?? 0) || 0;
    const y = Number(bbox.y ?? bbox.top ?? 0) || 0;
    const w = Number(bbox.width ?? bbox.w ?? 0) || 0;
    const h = Number(bbox.height ?? bbox.h ?? 0) || 0;
    return [x, y, w, h];
  }

  // Handle browser DOM element getBoundingClientRect if available
  if (el && typeof el.getBoundingClientRect === 'function') {
    try {
      const rect = el.getBoundingClientRect();
      return [
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height)
      ];
    } catch (_) {
      // Fallback
    }
  }

  return [0, 0, 0, 0];
}

/**
 * Generates or normalizes a CSS selector for a node.
 *
 * @param {Object} node - Skeleton node or DOM element
 * @returns {string} CSS selector
 */
export function getSelectorForNode(node) {
  if (!node) return 'unknown';

  if (typeof node.selector === 'string' && node.selector.trim()) {
    return node.selector.trim();
  }

  const id = node.id || (typeof node.getAttribute === 'function' ? node.getAttribute('id') : null);
  if (id && typeof id === 'string') {
    const escaped = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
      ? CSS.escape(id)
      : id.replace(/[^\w-]/g, '\\$&');
    return `#${escaped}`;
  }

  const tag = (node.tag || node.tagName || 'input').toLowerCase();
  const name = node.name || (typeof node.getAttribute === 'function' ? node.getAttribute('name') : null);
  if (name && typeof name === 'string') {
    return `${tag}[name="${name}"]`;
  }

  const type = node.type || (typeof node.getAttribute === 'function' ? node.getAttribute('type') : null);
  if (type && typeof type === 'string') {
    return `${tag}[type="${type}"]`;
  }

  return tag;
}

/**
 * Extracts all relevant text and attribute strings from a node for regex testing.
 *
 * @param {Object} node - DOM node or skeleton node
 * @returns {Object} String fields
 */
function extractNodeAttributes(node) {
  if (!node) {
    return { tag: '', type: '', autocomplete: '', name: '', id: '', ariaLabel: '', placeholder: '', text: '', piiType: '' };
  }

  const tag = String(node.tag || node.tagName || '').toLowerCase();
  
  const type = String(
    node.type ||
    (typeof node.getAttribute === 'function' ? node.getAttribute('type') : '') ||
    ''
  ).toLowerCase();

  const autocomplete = String(
    node.autocomplete ||
    node.autoComplete ||
    (typeof node.getAttribute === 'function' ? node.getAttribute('autocomplete') : '') ||
    ''
  ).toLowerCase();

  const name = String(
    node.name ||
    (typeof node.getAttribute === 'function' ? node.getAttribute('name') : '') ||
    ''
  );

  const id = String(
    node.id ||
    (typeof node.getAttribute === 'function' ? node.getAttribute('id') : '') ||
    ''
  );

  const className = String(
    node.className ||
    node.class ||
    (typeof node.getAttribute === 'function' ? node.getAttribute('class') : '') ||
    ''
  );

  const ariaLabel = String(
    node.ariaLabel ||
    node['aria-label'] ||
    node.aria_label ||
    (typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : '') ||
    ''
  );

  const placeholder = String(
    node.placeholder ||
    (typeof node.getAttribute === 'function' ? node.getAttribute('placeholder') : '') ||
    ''
  );

  const text = String(
    node.text ||
    node.textContent ||
    node.label ||
    node.labelText ||
    ''
  );

  const piiType = String(
    node.dataPiiType ||
    node.piiType ||
    node.dataset?.piiType ||
    node.dataset?.pii ||
    node['data-pii-type'] ||
    node['data-pii'] ||
    (typeof node.getAttribute === 'function' ? (node.getAttribute('data-pii-type') || node.getAttribute('data-pii')) : '') ||
    ''
  ).toLowerCase().trim();

  return { tag, type, autocomplete, name, id, className, ariaLabel, placeholder, text, piiType };
}

/**
 * Tokenizes a string on camelCase, separators, and punctuation, then finds
 * any sensitive keyword in the token stream. Prevents false positive substring matches
 * (e.g. 'shipping_address' containing 'pin' or 'syntax' containing 'tax').
 *
 * @param {string} str - Attribute value or identifier
 * @returns {string|null} Matched sensitive keyword or null
 */
export function findSensitiveKeyword(str) {
  if (!str || typeof str !== 'string') return null;

  // Split camelCase words and punctuation/delimiters
  const normalized = str.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const tokens = normalized.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (SENSITIVE_KEYWORDS.has(lower)) {
      return lower;
    }
  }

  // Compound matches without delimiters
  const compact = str.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact.includes('creditcard') || compact.includes('cardnumber')) {
    return 'card';
  }
  if (compact.includes('socialsecurity')) {
    return 'ssn';
  }
  if (compact.includes('securitycode') || compact.includes('cvv') || compact.includes('cvc')) {
    return 'card';
  }

  return null;
}

/**
 * Maps a keyword match to a standard category name.
 *
 * @param {string} match - Matched keyword
 * @param {Object} [options={}] - Custom categorization options
 * @returns {string} Category name
 */
export function mapKeywordToCategory(match, options = {}) {
  const m = String(match).toLowerCase();

  if (/(?:password|passwd|pwd|passcode|secret)/i.test(m)) {
    return SENSITIVE_CATEGORIES.PASSWORD;
  }
  if (/(?:card|cvv|cvc|pan|cc)/i.test(m)) {
    return SENSITIVE_CATEGORIES.CARD;
  }
  if (/(?:ssn|social)/i.test(m)) {
    return SENSITIVE_CATEGORIES.SSN;
  }
  if (/(?:tax)/i.test(m)) {
    return options.taxCategory || SENSITIVE_CATEGORIES.TAX;
  }
  if (/(?:otp)/i.test(m)) {
    return options.otpCategory || SENSITIVE_CATEGORIES.OTP;
  }
  if (/(?:pin)/i.test(m)) {
    return options.pinCategory || SENSITIVE_CATEGORIES.PIN;
  }
  if (/(?:email)/i.test(m)) {
    return SENSITIVE_CATEGORIES.EMAIL;
  }
  if (/(?:tel|phone)/i.test(m)) {
    return options.telCategory || SENSITIVE_CATEGORIES.PHONE;
  }
  if (/(?:name|fullname)/i.test(m)) {
    return 'name';
  }
  if (/(?:bank|routing|account|financial)/i.test(m)) {
    return options.financialCategory || SENSITIVE_CATEGORIES.CARD;
  }
  if (/(?:address|street|city|zip|dob|birth)/i.test(m)) {
    return 'pii';
  }

  return m;
}

/**
 * Evaluates whether a single DOM node or skeleton node is sensitive.
 * 
 * Rules applied in order:
 * 0. data-pii-type / data-pii attribute match
 * 1. input[type=password] -> category: 'password'
 * 2. autocomplete attributes matching cc-*|email|tel:
 *    - cc-* -> category: 'card'
 *    - email -> category: 'email'
 *    - tel -> category: 'phone' (or options.telCategory)
 * 3. type=email, tel, number (if labeled or named card/pin):
 *    - type=email -> category: 'email'
 *    - type=tel -> category: 'phone' (or options.telCategory)
 *    - type=number (labeled or named card/pin):
 *      - card/cvv/cvc/pan -> category: 'card'
 *      - pin -> category: 'pin'
 * 4. name/id/aria-label/placeholder regex matching ssn|social|card|cvv|cvc|otp|pan|pin|password|secret|tax
 *
 * @param {Object} node - Skeleton node or DOM element
 * @param {Object} [options={}] - Evaluation options
 * @returns {{ category: string, rule: string }|null} Detection result or null
 */
export function evaluateElementSensitivity(node, options = {}) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const { tag, type, autocomplete, name, id, className, ariaLabel, placeholder, text, piiType } = extractNodeAttributes(node);

  // --------------------------------------------------------------------------
  // Rule 0: Explicit data-pii-type / data-pii attribute
  // --------------------------------------------------------------------------
  if (piiType) {
    if (piiType === 'credit-card' || piiType === 'card') {
      return { category: SENSITIVE_CATEGORIES.CARD, rule: 'data_pii_card' };
    }
    if (piiType === 'email') {
      return { category: SENSITIVE_CATEGORIES.EMAIL, rule: 'data_pii_email' };
    }
    if (piiType === 'password') {
      return { category: SENSITIVE_CATEGORIES.PASSWORD, rule: 'data_pii_password' };
    }
    if (piiType === 'pin') {
      return { category: options.pinCategory || SENSITIVE_CATEGORIES.PIN, rule: 'data_pii_pin' };
    }
    if (piiType === 'phone' || piiType === 'tel') {
      return { category: options.telCategory || SENSITIVE_CATEGORIES.PHONE, rule: 'data_pii_phone' };
    }
    if (piiType === 'ssn') {
      return { category: SENSITIVE_CATEGORIES.SSN, rule: 'data_pii_ssn' };
    }
    if (piiType === 'name') {
      return { category: 'name', rule: 'data_pii_name' };
    }
    if (piiType === 'financial') {
      return { category: options.financialCategory || SENSITIVE_CATEGORIES.CARD, rule: 'data_pii_financial' };
    }
    if (piiType === 'address') {
      return { category: 'pii', rule: 'data_pii_address' };
    }
    if (piiType === 'dob') {
      return { category: 'pii', rule: 'data_pii_dob' };
    }
    if (piiType === 'face') {
      return { category: 'face', rule: 'data_pii_face' };
    }
    return { category: piiType, rule: `data_pii_${piiType}` };
  }

  // --------------------------------------------------------------------------
  // Rule 1: input[type=password] -> category: 'password'
  // --------------------------------------------------------------------------
  if (type === 'password') {
    return {
      category: SENSITIVE_CATEGORIES.PASSWORD,
      rule: 'type_password'
    };
  }

  // --------------------------------------------------------------------------
  // Rule 2: autocomplete attributes matching cc-*|email|tel
  // --------------------------------------------------------------------------
  if (autocomplete) {
    if (AUTOCOMPLETE_PATTERNS.CARD.test(autocomplete)) {
      return {
        category: SENSITIVE_CATEGORIES.CARD,
        rule: 'autocomplete_card'
      };
    }
    if (AUTOCOMPLETE_PATTERNS.EMAIL.test(autocomplete)) {
      return {
        category: SENSITIVE_CATEGORIES.EMAIL,
        rule: 'autocomplete_email'
      };
    }
    if (AUTOCOMPLETE_PATTERNS.TEL.test(autocomplete)) {
      return {
        category: options.telCategory || SENSITIVE_CATEGORIES.PHONE,
        rule: 'autocomplete_tel'
      };
    }
    if (AUTOCOMPLETE_PATTERNS.NAME.test(autocomplete)) {
      return {
        category: 'name',
        rule: 'autocomplete_name'
      };
    }
  }

  // --------------------------------------------------------------------------
  // Rule 3: type=email, tel, number (if labeled or named card/pin)
  // --------------------------------------------------------------------------
  if (type === 'email') {
    return {
      category: SENSITIVE_CATEGORIES.EMAIL,
      rule: 'type_email'
    };
  }

  if (type === 'tel') {
    return {
      category: options.telCategory || SENSITIVE_CATEGORIES.PHONE,
      rule: 'type_tel'
    };
  }

  // --------------------------------------------------------------------------
  // Rule 3.5: Form inputs for personal names (when enabled via options)
  // --------------------------------------------------------------------------
  if (options.detectFormNames === true && (tag === 'input' || tag === 'textarea')) {
    if (FORM_NAME_FIELD_REGEX.test(name) || FORM_NAME_FIELD_REGEX.test(id)) {
      return {
        category: 'name',
        rule: 'form_name_input'
      };
    }
    if (FORM_NAME_CONTAINS_REGEX.test(placeholder) || FORM_NAME_CONTAINS_REGEX.test(ariaLabel)) {
      return {
        category: 'name',
        rule: 'form_name_placeholder'
      };
    }
  }

  if (type === 'number') {
    // Only sensitive if labeled or named card/pin
    const combinedIdentifiers = [name, id, ariaLabel, placeholder, text].filter(Boolean).join(' ');
    const kw = findSensitiveKeyword(combinedIdentifiers);
    if (kw) {
      if (['card', 'cvv', 'cvc', 'pan'].includes(kw)) {
        return {
          category: SENSITIVE_CATEGORIES.CARD,
          rule: 'type_number_card'
        };
      }
      if (kw === 'pin') {
        return {
          category: options.pinCategory || SENSITIVE_CATEGORIES.PIN,
          rule: 'type_number_pin'
        };
      }
    }
  }

  // --------------------------------------------------------------------------
  // Rule 4: name/id/aria-label/placeholder regex matching:
  // ssn|social|card|cvv|cvc|otp|pan|pin|password|secret|tax
  // (Excludes className and structural headings to prevent redacting card-titles and UI cards)
  // --------------------------------------------------------------------------
  if (!NON_SENSITIVE_STRUCTURAL_TAGS.has(tag)) {
    const isContainerWithChildren = Array.isArray(node.children) && node.children.length > 0;
    const attributesToTest = [
      { name: 'name', value: name },
      { name: 'aria-label', value: ariaLabel },
      { name: 'placeholder', value: placeholder }
    ];

    // Only test 'id' for non-container or interactive elements to prevent marking outer card wrappers
    if (!isContainerWithChildren) {
      attributesToTest.push({ name: 'id', value: id });
    }

    for (const attr of attributesToTest) {
      if (!attr.value) continue;

      const keyword = findSensitiveKeyword(attr.value);
      if (keyword) {
        return {
          category: mapKeywordToCategory(keyword, options),
          rule: `regex_${attr.name}_${keyword.toLowerCase()}`
        };
      }
    }
  }

  // --------------------------------------------------------------------------
  // Rule 5: Value / Text Content pattern detection (Card, SSN, Email)
  // Catches visual credit cards, display numbers, and formatted PII strings
  // --------------------------------------------------------------------------
  const contentToInspect = [text, node.value].filter(Boolean).join(' ');
  if (contentToInspect) {
    if (/\b(?:\d{4}[ -]?){3}\d{4}\b/.test(contentToInspect)) {
      return {
        category: SENSITIVE_CATEGORIES.CARD,
        rule: 'pattern_credit_card'
      };
    }
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(contentToInspect)) {
      return {
        category: SENSITIVE_CATEGORIES.SSN,
        rule: 'pattern_ssn'
      };
    }
    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(contentToInspect)) {
      return {
        category: SENSITIVE_CATEGORIES.EMAIL,
        rule: 'pattern_email'
      };
    }
  }

  // Optional: check associated label / text keywords if enabled
  if (options.checkText && text) {
    const keyword = findSensitiveKeyword(text);
    if (keyword) {
      return {
        category: mapKeywordToCategory(keyword, options),
        rule: `regex_text_${keyword.toLowerCase()}`
      };
    }
  }

  return null;
}

/**
 * Pure function that scans a DOM skeleton tree or list of elements and returns
 * all sensitive elements matching security rules.
 *
 * @param {Object|Array|null} domSkeleton - DOM skeleton tree, array of elements, or envelope
 * @param {Object} [options={}] - Detection options
 * @param {string} [options.telCategory='phone'] - Override category for tel matches (e.g. 'phone' or 'tel')
 * @param {string} [options.pinCategory='pin'] - Override category for PIN matches
 * @param {string} [options.taxCategory='tax'] - Override category for tax matches
 * @param {string} [options.otpCategory='otp'] - Override category for OTP matches
 * @param {boolean} [options.checkText=false] - Also test textContent/label text against sensitive regex
 * @param {boolean} [options.deduplicate=true] - Deduplicate detections with identical selectors
 * @returns {Array<{ bbox: [number, number, number, number], category: string, source: 'dom', confidence: number, selector: string }>}
 */
export function detectSensitiveDomElements(domSkeleton, options = {}) {
  if (!domSkeleton) {
    return [];
  }

  const results = [];
  const visitedSelectors = new Set();
  const deduplicate = options.deduplicate !== false;

  // Extract semantic identities (JSON-LD, og:title, author, microformats)
  const semanticNames = [...(options.names || extractSemanticIdentities(domSkeleton))];
  const semanticNameSet = new Set(semanticNames.map(n => n.toLowerCase().trim()));

  /**
   * Recursive collector for nodes.
   *
   * @param {Object} node
   */
  function inspectNode(node) {
    if (!node || typeof node !== 'object') {
      return;
    }

    // Handle envelope formats (e.g. { skeleton: ... }, { tree: ... }, { elements: [...] })
    if (node.skeleton && node.skeleton !== node) {
      inspectNode(node.skeleton);
    }
    if (node.tree && node.tree !== node) {
      inspectNode(node.tree);
    }
    if (Array.isArray(node.elements)) {
      for (const el of node.elements) {
        inspectNode(el);
      }
    }

    // Evaluate current node
    const detection = evaluateElementSensitivity(node, options);
    let category = detection?.category || null;

    // Check if node text matches any extracted semantic name
    if (!category && semanticNameSet.size > 0) {
      const nodeText = String(node.text || node.textContent || '').trim();
      if (nodeText && nodeText.length <= 50 && semanticNameSet.has(nodeText.toLowerCase())) {
        category = 'name';
      }
    }

    if (category) {
      const selector = getSelectorForNode(node);
      const bbox = normalizeBBox(node.bbox, node);

      if (!deduplicate || !visitedSelectors.has(selector)) {
        visitedSelectors.add(selector);
        const item = {
          bbox,
          category,
          source: 'dom',
          confidence: 1.0,
          selector
        };
        const textVal = node.text || node.textContent || node.value;
        if (typeof textVal === 'string' && textVal.trim()) {
          item.text = textVal.trim();
        }
        results.push(item);
      }
    }

    // Recursively traverse children
    const children = node.children || (typeof node.childNodes !== 'undefined' ? Array.from(node.childNodes) : null);
    if (Array.isArray(children)) {
      for (let i = 0; i < children.length; i++) {
        inspectNode(children[i]);
      }
    }
  }

  // Handle array of nodes
  if (Array.isArray(domSkeleton)) {
    for (const item of domSkeleton) {
      inspectNode(item);
    }
  } else {
    inspectNode(domSkeleton);
  }

  // Correlate face regions if provided
  if (Array.isArray(options.faceRegions) && options.faceRegions.length > 0) {
    const faceCorrelations = correlateFaceWithHeadings(options.faceRegions, domSkeleton, options);
    for (const item of faceCorrelations) {
      if (!deduplicate || !visitedSelectors.has(item.selector)) {
        visitedSelectors.add(item.selector);
        results.push(item);
        if (item.text) semanticNames.push(item.text);
      }
    }
  }

  if (typeof options.onExtractedNames === 'function') {
    options.onExtractedNames(Array.from(new Set(semanticNames)));
  }

  return results;
}

// Attach to global scope for browser runtime if available
if (typeof globalThis !== 'undefined') {
  globalThis.detectSensitiveDomElements = detectSensitiveDomElements;
}

export default detectSensitiveDomElements;
