/**
 * Content script for DOM Skeleton Extraction.
 * Traverses the DOM to extract a lightweight JSON tree of visible interactive and content elements.
 */

// Helper sets for classification
const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'details', 'summary', 'option'
]);

const CONTENT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'u',
  'label', 'li', 'td', 'th', 'caption', 'blockquote', 'pre', 'code', 'img', 'svg'
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'combobox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'textbox', 'searchbox', 'slider', 'spinbutton'
]);

/**
 * Escapes characters for CSS selector IDs.
 */
function safeEscapeId(id) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id);
  }
  return id.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');
}

/**
 * Resolves implicit or explicit ARIA role.
 */
function getRole(el) {
  if (!el || !el.getAttribute) return null;
  const explicitRole = el.getAttribute('role');
  if (explicitRole && explicitRole.trim()) {
    return explicitRole.trim().toLowerCase();
  }

  const tag = (el.tagName || '').toLowerCase();
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : null;
    case 'button':
      return 'button';
    case 'input': {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(type)) return 'textbox';
      return 'textbox';
    }
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return 'img';
    case 'li':
      return 'listitem';
    case 'ul':
    case 'ol':
      return 'list';
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'form':
      return 'form';
    case 'table':
      return 'table';
    default:
      return null;
  }
}

/**
 * Determines if an element is interactive.
 */
function isInteractive(el, role) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute && (el.hasAttribute('onclick') || el.hasAttribute('tabindex'))) return true;
  if (el.isContentEditable) return true;

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(el);
      if (style && style.cursor === 'pointer') return true;
    } catch (_) {}
  }
  return false;
}

/**
 * Resolves accessible label (aria-label, aria-labelledby, title, alt, or for-label).
 */
function getAriaLabel(el) {
  if (!el || !el.getAttribute) return null;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy && typeof document !== 'undefined') {
    const ids = labelledBy.trim().split(/\s+/);
    const labels = [];
    for (const id of ids) {
      const labelEl = document.getElementById(id);
      if (labelEl) {
        const text = (labelEl.innerText || labelEl.textContent || '').trim();
        if (text) labels.push(text);
      }
    }
    if (labels.length > 0) return labels.join(' ');
  }

  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();

  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim();

  if (el.id && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    try {
      const labelEl = document.querySelector(`label[for="${safeEscapeId(el.id)}"]`);
      if (labelEl) {
        const text = (labelEl.innerText || labelEl.textContent || '').trim();
        if (text) return text;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Extracts visible text content without duplicating entire subtree texts for generic containers.
 */
function getElementText(el) {
  if (!el || !el.tagName) return '';
  const tag = el.tagName.toLowerCase();

  if (tag === 'input' || tag === 'textarea') {
    return el.value || el.getAttribute('placeholder') || '';
  }
  if (tag === 'select') {
    if (el.selectedOptions && el.selectedOptions.length > 0) {
      return el.selectedOptions[0].text || el.selectedOptions[0].textContent || '';
    }
    return '';
  }
  if (tag === 'img') {
    return el.getAttribute('alt') || '';
  }

  const isLeafOrInteractive = INTERACTIVE_TAGS.has(tag) ||
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'summary', 'option', 'span', 'p'].includes(tag) ||
    (!el.children || el.children.length === 0);

  if (isLeafOrInteractive) {
    return (el.innerText || el.textContent || '').trim();
  }

  // For containers, extract direct text node contents to avoid duplicating large descendant trees
  let directText = '';
  if (el.childNodes) {
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child.nodeType === 3) { // Node.TEXT_NODE
        directText += child.textContent || '';
      }
    }
  }
  return directText.trim();
}

/**
 * Generates a valid unique CSS selector.
 */
function getCssSelector(el) {
  if (!el || !el.tagName) return '';
  if (typeof document !== 'undefined') {
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
  }

  if (el.id && !/\s/.test(el.id)) {
    return `#${safeEscapeId(el.id)}`;
  }

  const path = [];
  let curr = el;
  while (curr && curr.nodeType === 1) { // Node.ELEMENT_NODE
    if (typeof document !== 'undefined' && curr === document.body) {
      path.unshift('body');
      break;
    }
    if (curr.id && !/\s/.test(curr.id)) {
      path.unshift(`#${safeEscapeId(curr.id)}`);
      break;
    }

    let tagName = curr.tagName.toLowerCase();
    let sibling = curr;
    let nth = 1;
    let hasSiblingsWithSameTag = false;

    if (curr.parentElement && curr.parentElement.children) {
      for (let i = 0; i < curr.parentElement.children.length; i++) {
        const child = curr.parentElement.children[i];
        if (child !== curr && child.tagName && child.tagName.toLowerCase() === tagName) {
          hasSiblingsWithSameTag = true;
          break;
        }
      }
    }

    if (hasSiblingsWithSameTag) {
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName && sibling.tagName.toLowerCase() === tagName) {
          nth++;
        }
      }
      tagName += `:nth-of-type(${nth})`;
    }

    path.unshift(tagName);
    curr = curr.parentElement;
  }

  return path.join(' > ');
}

/**
 * Generates an XPath string for the element.
 */
function getXPath(el) {
  if (!el || !el.tagName) return '';
  if (typeof document !== 'undefined') {
    if (el === document.body) return '/html/body';
    if (el === document.documentElement) return '/html';
  }

  const segments = [];
  let curr = el;
  while (curr && curr.nodeType === 1 && curr.tagName.toLowerCase() !== 'html') {
    const tag = curr.tagName.toLowerCase();
    if (tag === 'body') {
      segments.unshift('body');
      break;
    }

    let index = 1;
    let sibling = curr.previousSibling;
    while (sibling) {
      if (sibling.nodeType === 1 && sibling.tagName && sibling.tagName.toLowerCase() === tag) {
        index++;
      }
      sibling = sibling.previousSibling;
    }
    segments.unshift(`${tag}[${index}]`);
    curr = curr.parentNode;
  }

  return '/html/' + segments.join('/');
}

/**
 * Computes bounding box [x, y, w, h] relative to viewport.
 */
function getBoundingBox(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return [0, 0, 0, 0];
  }
  const rect = el.getBoundingClientRect();
  return [
    Math.round(rect.left * 100) / 100,
    Math.round(rect.top * 100) / 100,
    Math.round(rect.width * 100) / 100,
    Math.round(rect.height * 100) / 100
  ];
}

/**
 * Checks if an element is visible in the page.
 */
function isElementVisible(el) {
  if (!el || el.nodeType !== 1) return false;

  // Check direct element style if set
  if (el.style) {
    if (el.style.display === 'none' || el.style.visibility === 'hidden' || el.style.opacity === '0') {
      return false;
    }
  }

  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(el);
      if (style) {
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
      }
    } catch (_) {}
  }

  return true;
}

/**
 * Traverses DOM and builds a structured JSON skeleton of visible elements.
 *
 * @param {Element} [root] - Root DOM node to traverse (defaults to document.body).
 * @param {Object} [options] - Traversal options.
 * @param {boolean} [options.inViewportOnly=false] - Only include elements intersecting the viewport.
 * @param {number} [options.maxDepth=50] - Maximum recursion depth.
 * @returns {Object|null} Structured JSON node representing the tree.
 */
function extractDomSkeleton(root = (typeof document !== 'undefined' ? document.body : null), options = {}) {
  if (!root) return null;

  const inViewportOnly = options.inViewportOnly === true;
  const maxDepth = options.maxDepth || 50;

  function traverse(el, depth = 0) {
    if (!el || el.nodeType !== 1 || depth > maxDepth) return null;

    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'head', 'meta', 'link'].includes(tag)) {
      return null;
    }

    // Ignore test manifest reference drawer and elements
    if (el.id === 'manifestView' || el.id === 'pii-manifest' || (el.classList && el.classList.contains('manifest-drawer'))) {
      return null;
    }
    const closedDetails = el.closest ? el.closest('details:not([open])') : null;
    if (closedDetails && !el.closest('summary')) {
      return null;
    }

    if (!isElementVisible(el)) {
      return null;
    }

    const bbox = getBoundingBox(el);

    if (inViewportOnly && (bbox[2] > 0 || bbox[3] > 0)) {
      const vw = typeof window !== 'undefined' ? (window.innerWidth || 1024) : 1024;
      const vh = typeof window !== 'undefined' ? (window.innerHeight || 768) : 768;
      const [x, y, w, h] = bbox;
      if (x + w < 0 || y + h < 0 || x > vw || y > vh) {
        return null;
      }
    }

    // Recursively process child elements
    const children = [];
    if (el.children) {
      for (let i = 0; i < el.children.length; i++) {
        const childNode = traverse(el.children[i], depth + 1);
        if (childNode) {
          children.push(childNode);
        }
      }
    }

    const role = getRole(el);
    const interactive = isInteractive(el, role);
    const text = getElementText(el);
    const ariaLabel = getAriaLabel(el);
    const typeAttr = el.getAttribute ? (el.getAttribute('type') || (el.type || null)) : null;
    const hasPiiAttr = Boolean(el.getAttribute && (el.getAttribute('data-pii-type') || el.getAttribute('data-pii')));
    const isLeafText = (!el.children || el.children.length === 0) && text.length > 0;
    const isContent = (CONTENT_TAGS.has(tag) || isLeafText) && text.length > 0;
    const isRoot = el === root;

    // Prune invisible/empty non-interactive containers with no kept children
    const keepNode = isRoot || interactive || isContent || ariaLabel !== null || hasPiiAttr || children.length > 0;
    if (!keepNode) {
      return null;
    }

    return {
      tag,
      role,
      bbox,
      type: typeAttr,
      ariaLabel,
      text,
      selector: getCssSelector(el),
      xpath: getXPath(el),
      id: el.id || null,
      name: el.getAttribute ? (el.getAttribute('name') || null) : null,
      className: el.className || null,
      autocomplete: el.getAttribute ? (el.getAttribute('autocomplete') || (el.autocomplete || null)) : null,
      placeholder: el.getAttribute ? (el.getAttribute('placeholder') || null) : null,
      value: (tag === 'input' || tag === 'textarea') ? (el.value || null) : null,
      href: (tag === 'a' || tag === 'link') && el.getAttribute ? (el.getAttribute('href') || null) : null,
      src: (tag === 'img' || tag === 'iframe') && el.getAttribute ? (el.getAttribute('src') || null) : null,
      dataPiiType: el.getAttribute ? (el.getAttribute('data-pii-type') || el.getAttribute('data-pii') || null) : null,
      interactive,
      children
    };
  }

  const tree = traverse(root);
  if (!tree) return null;

  // Collect page-level metadata if document is available
  if (typeof document !== 'undefined') {
    const ldJson = [];
    const ldScripts = document.querySelectorAll ? document.querySelectorAll('script[type="application/ld+json"]') : [];
    for (const s of ldScripts) {
      try {
        const parsed = JSON.parse(s.textContent || '');
        if (Array.isArray(parsed)) ldJson.push(...parsed);
        else if (parsed) ldJson.push(parsed);
      } catch (_) {}
    }

    tree.metadata = {
      title: document.title || '',
      ogTitle: document.querySelector ? document.querySelector('meta[property="og:title"]')?.getAttribute('content') : null,
      author: document.querySelector ? document.querySelector('meta[name="author"]')?.getAttribute('content') : null,
      ldJson
    };
  }

  return tree;
}

/**
 * Flattens a DOM skeleton tree into an array of interactive and content leaf elements.
 */
function flattenSkeleton(node) {
  if (!node) return [];
  const list = [];

  function collect(n) {
    if (n.interactive || (n.text && (!n.children || n.children.length === 0)) || n.ariaLabel) {
      const { children, ...flatItem } = n;
      list.push(flatItem);
    }
    if (n.children && n.children.length > 0) {
      for (let i = 0; i < n.children.length; i++) {
        collect(n.children[i]);
      }
    }
  }

  collect(node);
  return list;
}

// Action execution functions (Ticket 06)

/**
 * Computes center coordinates { x, y } in viewport space from target specification.
 * Automatically converts normalized coordinates [0..1] or downscaled canvas coordinates
 * back to full viewport CSS pixel space.
 *
 * @param {Object} target - Target locator with coordinates or bbox
 * @param {Object} [options={}] - Options (scale, viewport, image, coordinate_space)
 * @returns {{ x: number, y: number }|null}
 */
function getCenterCoordinates(target, options = {}) {
  if (!target || typeof target !== 'object') return null;

  let rawX = null;
  let rawY = null;

  if (Array.isArray(target) && target.length >= 2) {
    const x = Number(target[0]) || 0;
    const y = Number(target[1]) || 0;
    const w = Number(target[2]) || 0;
    const h = Number(target[3]) || 0;
    rawX = x + w / 2;
    rawY = y + h / 2;
  } else if (typeof target.x === 'number' && typeof target.y === 'number') {
    rawX = target.x;
    rawY = target.y;
  } else {
    const pt = target.point || target.coordinates;
    if (Array.isArray(pt) && pt.length >= 2) {
      rawX = Number(pt[0]) || 0;
      rawY = Number(pt[1]) || 0;
    } else if (pt && typeof pt === 'object') {
      if (typeof pt.x === 'number' && typeof pt.y === 'number') {
        rawX = pt.x;
        rawY = pt.y;
      } else if (typeof pt.clientX === 'number' && typeof pt.clientY === 'number') {
        rawX = pt.clientX;
        rawY = pt.clientY;
      }
    }

    if (rawX === null) {
      const bbox = target.target_bbox || target.bbox;
      if (Array.isArray(bbox) && bbox.length >= 2) {
        const x = Number(bbox[0]) || 0;
        const y = Number(bbox[1]) || 0;
        const w = Number(bbox[2]) || 0;
        const h = Number(bbox[3]) || 0;
        rawX = x + w / 2;
        rawY = y + h / 2;
      } else if (bbox && typeof bbox === 'object') {
        const x = Number(bbox.x ?? bbox.left ?? 0);
        const y = Number(bbox.y ?? bbox.top ?? 0);
        const w = Number(bbox.width ?? bbox.w ?? 0);
        const h = Number(bbox.height ?? bbox.h ?? 0);
        rawX = x + w / 2;
        rawY = y + h / 2;
      }
    }
  }

  if (rawX === null || rawY === null) return null;

  const win = typeof window !== 'undefined' ? window : null;
  const vpWidth = win?.innerWidth || options.viewport?.width || 1024;
  const vpHeight = win?.innerHeight || options.viewport?.height || 768;

  // Case 1: Normalized [0..1]
  if (rawX > 0 && rawX <= 1.0 && rawY > 0 && rawY <= 1.0) {
    return {
      x: Math.round(rawX * vpWidth),
      y: Math.round(rawY * vpHeight)
    };
  }

  // Case 2: 1000-scale [0..1000]
  if (options.coordinate_space === 'norm1000' || target.coordinate_space === 'norm1000' ||
      (options.coordinate_space === '1000' && rawX <= 1000 && rawY <= 1000)) {
    return {
      x: Math.round((rawX / 1000) * vpWidth),
      y: Math.round((rawY / 1000) * vpHeight)
    };
  }

  // Case 3: Downscaled image scale (e.g. scale: 0.4)
  const scale = Number(options.scale || target.scale || options.image?.scale || 0);
  if (scale > 0 && scale < 1.0) {
    return {
      x: Math.round(rawX / scale),
      y: Math.round(rawY / scale)
    };
  }

  // Case 4: Image width/height specified (scale to viewport)
  const imgW = Number(options.image?.width || options.imageWidth || 0);
  const imgH = Number(options.image?.height || options.imageHeight || 0);
  if (imgW > 0 && imgH > 0 && (Math.abs(imgW - vpWidth) > 5 || Math.abs(imgH - vpHeight) > 5)) {
    if (rawX <= imgW + 10 && rawY <= imgH + 10) {
      return {
        x: Math.round(rawX * (vpWidth / imgW)),
        y: Math.round(rawY * (vpHeight / imgH))
      };
    }
  }

  return { x: Math.round(rawX), y: Math.round(rawY) };
}

/**
 * Resolves a DOM element from various locator strategies:
 * - Direct element
 * - Element ID / target_element_id
 * - CSS selector (target_selector, selector)
 * - XPath (target_xpath, xpath)
 * - Bounding box / coordinates via elementFromPoint with viewport scaling
 * - Text / label / placeholder search across interactive controls
 * - Semantic keyword fallback based on task / reason
 *
 * @param {Object|Element|string} target - Locator specification
 * @param {Object} [options={}] - Options (scale, viewport, task)
 * @returns {Element|null} The resolved DOM element or null
 */
function resolveTarget(target, options = {}) {
  if (!target) return null;

  if (typeof Element !== 'undefined' && target instanceof Element) {
    return target;
  }
  if (target.nodeType === 1) {
    return target;
  }
  if (target.element && (target.element.nodeType === 1 || (typeof Element !== 'undefined' && target.element instanceof Element))) {
    return target.element;
  }

  if (typeof target === 'string') {
    return resolveTarget({ selector: target }, options);
  }

  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return null;

  // 1. Try element_id / target_element_id / id
  const elementId = target.target_element_id || target.element_id || target.id;
  if (elementId && typeof elementId === 'string') {
    const rawId = elementId.trim();
    const cleanId = rawId.startsWith('#') ? rawId.slice(1) : rawId;
    try {
      if (typeof doc.getElementById === 'function') {
        const el = doc.getElementById(cleanId);
        if (el) return el;
      }
      if (typeof doc.querySelector === 'function') {
        const sanitized = cleanId.replace(/["'\\]/g, '');
        const el = doc.querySelector(`[data-element-id="${sanitized}"], [id="${sanitized}"]`);
        if (el) return el;
      }
    } catch (_) {}
  }

  // 2. Try CSS selector
  const selector = target.target_selector || target.selector || target.cssSelector;
  if (selector && typeof selector === 'string') {
    const sel = selector.trim();
    // If it looks like an ID without leading # e.g. "submit-btn" and contains no spaces/special selector chars
    if (/^[a-zA-Z0-9_\-]+$/.test(sel)) {
      const byId = doc.getElementById ? doc.getElementById(sel) : null;
      if (byId) return byId;
    }

    const isDangerous = /<script|javascript:|on\w+=/i.test(sel);
    if (!isDangerous) {
      try {
        if (typeof doc.querySelector === 'function') {
          const el = doc.querySelector(sel);
          if (el) return el;
        }
      } catch (_) {
        // Query selector failed (e.g. invalid selector syntax like text name)
      }
    }
  }

  // 3. Try XPath
  const xpath = target.target_xpath || target.xpath;
  if (xpath && typeof xpath === 'string') {
    try {
      if (typeof doc.evaluate === 'function') {
        const xpathType = (typeof XPathResult !== 'undefined' && XPathResult.FIRST_ORDERED_NODE_TYPE)
          ? XPathResult.FIRST_ORDERED_NODE_TYPE
          : 9;
        const result = doc.evaluate(xpath, doc, null, xpathType, null);
        if (result && result.singleNodeValue) {
          return result.singleNodeValue;
        }
      }
    } catch (_) {}
  }

  // 4. Try coordinates / bounding box via elementFromPoint with viewport scaling
  const coords = getCenterCoordinates(target, options);
  if (coords && typeof doc.elementFromPoint === 'function') {
    const el = doc.elementFromPoint(coords.x, coords.y);
    if (el) {
      // If hit non-interactive wrapper (e.g. SVG path, div), find closest interactive control
      const interactive = (typeof el.closest === 'function')
        ? (el.closest('button, a, input, select, textarea, [role="button"], [role="link"], [tabindex]') || el)
        : el;
      return interactive;
    }
  }

  // 5. Try finding by element text / label / placeholder / name
  const searchText = (target.text || target.label || target.name || target.placeholder || target.value || selector || '').trim();
  if (searchText && searchText.length < 100 && !searchText.startsWith('<')) {
    const searchLower = searchText.toLowerCase();
    const candidates = Array.from(doc.querySelectorAll('button, a, input, [role="button"], label, textarea'));
    for (const cand of candidates) {
      const candText = (cand.innerText || cand.textContent || '').trim().toLowerCase();
      const candVal = (cand.value || '').trim().toLowerCase();
      const candAria = (cand.getAttribute('aria-label') || '').trim().toLowerCase();
      const candName = (cand.getAttribute('name') || '').trim().toLowerCase();
      if (candText === searchLower || candVal === searchLower || candAria === searchLower || candName === searchLower) {
        return cand;
      }
    }
    // Partial contains match
    for (const cand of candidates) {
      const candText = (cand.innerText || cand.textContent || '').trim().toLowerCase();
      if (candText && (candText.includes(searchLower) || searchLower.includes(candText))) {
        return cand;
      }
    }
  }

  // 6. Semantic search from task description or action reason if still not found
  const fallbackQuery = (target.reason || options.task || '').toLowerCase();
  if (fallbackQuery) {
    const interactiveCandidates = Array.from(doc.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a'));
    for (const kw of ['submit', 'sign in', 'log in', 'login', 'continue', 'search', 'next', 'save', 'send', 'confirm']) {
      if (fallbackQuery.includes(kw)) {
        const found = interactiveCandidates.find(c => {
          const t = (c.innerText || c.textContent || c.value || c.getAttribute('aria-label') || '').toLowerCase();
          return t.includes(kw);
        });
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * Dispatches click action on a resolved element.
 * Focuses element and fires mousedown, mouseup, and click MouseEvents.
 *
 * @param {Object} params - Click parameters
 * @returns {Promise<Object>} Execution result
 */
async function executeClick(params = {}, options = {}) {
  const targetEl = resolveTarget(params, options);
  if (!targetEl) {
    throw new Error(`Target element not found for click: ${JSON.stringify(params)}`);
  }

  // Determine coordinates
  let coords = getCenterCoordinates(params, options);
  if (!coords && typeof targetEl.getBoundingClientRect === 'function') {
    const rect = targetEl.getBoundingClientRect();
    coords = {
      x: (rect.left || 0) + (rect.width || 0) / 2,
      y: (rect.top || 0) + (rect.height || 0) / 2
    };
  }
  const clientX = coords ? coords.x : 0;
  const clientY = coords ? coords.y : 0;

  // 1. Focus element
  if (typeof targetEl.focus === 'function') {
    try {
      targetEl.focus();
    } catch (_) {}
  }

  // 2. Dispatch MouseEvents
  const win = typeof window !== 'undefined' ? window : null;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    detail: 1,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    button: 0,
    buttons: 1
  };

  const createMouseEvent = (type, init = {}) => {
    if (typeof MouseEvent === 'function') {
      try {
        return new MouseEvent(type, init);
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? true,
      composed: init.composed ?? true,
      detail: init.detail ?? 1,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      screenX: init.screenX ?? 0,
      screenY: init.screenY ?? 0,
      button: init.button ?? 0,
      buttons: init.buttons ?? 0,
      view: init.view ?? null,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  const downEvent = createMouseEvent('mousedown', eventInit);
  const upEvent = createMouseEvent('mouseup', { ...eventInit, buttons: 0 });
  const clickEvent = createMouseEvent('click', { ...eventInit, buttons: 0 });

  let dispatched = false;
  if (typeof targetEl.dispatchEvent === 'function') {
    targetEl.dispatchEvent(downEvent);
    targetEl.dispatchEvent(upEvent);
    targetEl.dispatchEvent(clickEvent);
    dispatched = true;
  }

  if (!dispatched && typeof targetEl.click === 'function') {
    targetEl.click();
  }

  return {
    success: true,
    action: 'click',
    target: {
      tagName: targetEl.tagName,
      id: targetEl.id || null,
      selector: typeof getCssSelector === 'function' ? getCssSelector(targetEl) : null,
      coordinates: { x: clientX, y: clientY }
    }
  };
}

/**
 * Dispatches scroll action on window or container element.
 *
 * @param {Object} params - Scroll parameters
 * @returns {Promise<Object>} Execution result
 */
async function executeScroll(params = {}) {
  const win = typeof window !== 'undefined' ? window : null;
  const doc = typeof document !== 'undefined' ? document : null;

  let container = null;
  if (params.target_selector || params.selector || params.target_bbox || params.bbox || params.element) {
    container = resolveTarget(params);
  }

  const behavior = params.behavior || 'smooth';

  let deltaX = params.deltaX ?? params.dx ?? null;
  let deltaY = params.deltaY ?? params.dy ?? null;

  if (params.direction) {
    const dir = String(params.direction).toLowerCase();
    const viewportHeight = (win && win.innerHeight) ? win.innerHeight : 768;
    const viewportWidth = (win && win.innerWidth) ? win.innerWidth : 1024;
    const distance = params.distance ?? Math.round(viewportHeight * 0.8);

    if (dir === 'down') deltaY = distance;
    else if (dir === 'up') deltaY = -distance;
    else if (dir === 'right') deltaX = params.distance ?? Math.round(viewportWidth * 0.8);
    else if (dir === 'left') deltaX = -(params.distance ?? Math.round(viewportWidth * 0.8));
  }

  let top = params.top ?? params.y ?? params.scrollTop ?? null;
  let left = params.left ?? params.x ?? params.scrollLeft ?? null;

  if (container) {
    if (deltaX !== null || deltaY !== null) {
      const dX = deltaX ?? 0;
      const dY = deltaY ?? 0;
      if (typeof container.scrollBy === 'function') {
        container.scrollBy({ left: dX, top: dY, behavior });
      } else {
        if (typeof container.scrollLeft === 'number') container.scrollLeft += dX;
        if (typeof container.scrollTop === 'number') container.scrollTop += dY;
      }
    } else if (top !== null || left !== null) {
      const targetTop = top ?? (container.scrollTop || 0);
      const targetLeft = left ?? (container.scrollLeft || 0);
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: targetTop, left: targetLeft, behavior });
      } else {
        if (top !== null) container.scrollTop = top;
        if (left !== null) container.scrollLeft = left;
      }
    }

    return {
      success: true,
      action: 'scroll',
      target: 'element',
      element: {
        tagName: container.tagName,
        id: container.id || null
      },
      scroll: {
        scrollLeft: container.scrollLeft || 0,
        scrollTop: container.scrollTop || 0
      }
    };
  }

  if (deltaX !== null || deltaY !== null) {
    const dX = deltaX ?? 0;
    const dY = deltaY ?? 0;
    if (win && typeof win.scrollBy === 'function') {
      win.scrollBy({ left: dX, top: dY, behavior });
    } else if (win && typeof win.scrollTo === 'function') {
      win.scrollTo({
        left: (win.scrollX || 0) + dX,
        top: (win.scrollY || 0) + dY,
        behavior
      });
    } else if (doc && doc.documentElement) {
      if (typeof doc.documentElement.scrollLeft === 'number') doc.documentElement.scrollLeft += dX;
      if (typeof doc.documentElement.scrollTop === 'number') doc.documentElement.scrollTop += dY;
    }
  } else if (top !== null || left !== null) {
    const targetTop = top ?? (win ? (win.scrollY || 0) : 0);
    const targetLeft = left ?? (win ? (win.scrollX || 0) : 0);
    if (win && typeof win.scrollTo === 'function') {
      win.scrollTo({ top: targetTop, left: targetLeft, behavior });
    } else if (doc && doc.documentElement) {
      if (top !== null) doc.documentElement.scrollTop = top;
      if (left !== null) doc.documentElement.scrollLeft = left;
    }
  }

  const scrollX = win ? (win.scrollX || 0) : (doc?.documentElement?.scrollLeft || 0);
  const scrollY = win ? (win.scrollY || 0) : (doc?.documentElement?.scrollTop || 0);

  return {
    success: true,
    action: 'scroll',
    target: 'window',
    scroll: {
      scrollX,
      scrollY
    }
  };
}

/**
 * Detects whether a DOM element or text contains sensitive/redacted information.
 * Refuses typing into password, credit card, ssn, or [REDACTED_*] fields
 * unless authorized by options or task parameters.
 *
 * @param {Element|null} element - Target DOM element
 * @param {string} [text=''] - Text to be typed
 * @param {Object} [options={}] - Execution options
 * @returns {boolean} True if field/text is sensitive/redacted and not explicitly authorized
 */
function isSensitiveField(element, text = '', options = {}) {
  const isAuthorized = Boolean(
    options.allowSensitive ||
    options.force ||
    options.overrideSensitive ||
    options.taskParameters?.allowSensitive ||
    options.task_parameters?.allowSensitive
  );
  if (isAuthorized) {
    return false;
  }

  // Check if text to type contains redaction markers
  if (typeof text === 'string' && /\[REDACTED(?:_[A-Z0-9]+)?\]/i.test(text)) {
    return true;
  }

  if (!element) return false;

  // 1. Password input type
  const type = (element.type || (typeof element.getAttribute === 'function' ? element.getAttribute('type') : '') || '').toLowerCase();
  if (type === 'password') {
    return true;
  }

  // 2. Sensitive autocomplete attributes
  const autocomplete = (element.autocomplete || (typeof element.getAttribute === 'function' ? element.getAttribute('autocomplete') : '') || '').toLowerCase();
  const sensitiveAutocompletes = [
    'current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp',
    'cc-exp-month', 'cc-exp-year', 'cc-type', 'transaction-amount', 'bday', 'sex', 'ssn'
  ];
  if (sensitiveAutocompletes.some(attr => autocomplete.includes(attr))) {
    return true;
  }

  // 3. Name, ID, Class, Placeholder, Aria-label pattern matching
  const name = (element.name || (typeof element.getAttribute === 'function' ? element.getAttribute('name') : '') || '').toLowerCase();
  const id = (element.id || (typeof element.getAttribute === 'function' ? element.getAttribute('id') : '') || '').toLowerCase();
  const placeholder = (element.placeholder || (typeof element.getAttribute === 'function' ? element.getAttribute('placeholder') : '') || '').toLowerCase();
  const ariaLabel = ((typeof element.getAttribute === 'function' ? element.getAttribute('aria-label') : '') || '').toLowerCase();
  const className = (typeof element.className === 'string' ? element.className : '').toLowerCase();

  const sensitivePattern = /(password|passwd|pwd|passcode|secret|credit[-_]?card|card[-_]?num|cvv|cvc|security[-_]?code|ssn|social[-_]?sec)/i;

  if (
    sensitivePattern.test(name) ||
    sensitivePattern.test(id) ||
    sensitivePattern.test(placeholder) ||
    sensitivePattern.test(ariaLabel) ||
    sensitivePattern.test(className)
  ) {
    return true;
  }

  // 4. Data attributes indicating redacted or sensitive
  if (
    (typeof element.getAttribute === 'function' && element.getAttribute('data-sensitive') === 'true') ||
    (typeof element.getAttribute === 'function' && element.getAttribute('data-redacted') === 'true') ||
    (typeof element.getAttribute === 'function' && element.getAttribute('data-privacy') === 'redacted')
  ) {
    return true;
  }

  // 5. Existing element value / text containing [REDACTED_*]
  const val = element.value || element.textContent || '';
  if (/\[REDACTED(?:_[A-Z0-9]+)?\]/i.test(val)) {
    return true;
  }

  return false;
}

/**
 * Executes a simulated typing action into a target input, textarea, or editable element.
 * Resolves target via selector, xpath, bbox, point, or direct element.
 * Enforces critical safety checks against sensitive/redacted fields.
 * Dispatches focus, beforeinput, input, keydown, keyup, and change events.
 *
 * @param {Object|Element|string} target - Target locator or action parameters
 * @param {string} [text] - Text to type
 * @param {Object} [options={}] - Options (clearFirst, delay, allowSensitive, blurAfter, etc.)
 * @returns {Promise<Object>} Execution result
 */
async function executeType(target, text, options = {}) {
  let targetParam = target;
  let textToType = text;
  let opts = options || {};

  // Support executeType(params) where params = { target, text, ... }
  if (
    typeof target === 'object' &&
    target !== null &&
    !Array.isArray(target) &&
    !(typeof Element !== 'undefined' && target instanceof Element) &&
    target.nodeType !== 1 &&
    text === undefined
  ) {
    targetParam = target.target || target.element || target;
    textToType = target.text ?? target.value ?? '';
    opts = { ...target, ...options };
  } else if (text !== undefined) {
    textToType = String(text);
  } else {
    textToType = '';
  }

  const targetEl = resolveTarget(targetParam, opts);
  if (!targetEl) {
    throw new Error(`Target element not found for type: ${JSON.stringify(targetParam)}`);
  }

  // CRITICAL SAFETY CHECK
  if (isSensitiveField(targetEl, textToType, opts)) {
    const err = new Error(`Safety Refusal: Refusing to type into sensitive/redacted field or type redacted data without explicit authorization.`);
    err.refused = true;
    err.sensitive = true;
    throw err;
  }

  // 1. Focus element
  if (typeof targetEl.focus === 'function') {
    try {
      targetEl.focus();
    } catch (_) {}
  }

  const win = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null);

  const createKeyboardEvent = (type, key, init = {}) => {
    if (win && typeof win.KeyboardEvent === 'function') {
      try {
        return new win.KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          key,
          code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          charCode: key.charCodeAt(0),
          keyCode: key.charCodeAt(0),
          which: key.charCodeAt(0),
          view: win,
          ...init
        });
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? true,
      composed: init.composed ?? true,
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  const createInputEvent = (type, data, inputType = 'insertText', init = {}) => {
    if (win && typeof win.InputEvent === 'function') {
      try {
        return new win.InputEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          data,
          inputType,
          view: win,
          ...init
        });
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? true,
      composed: init.composed ?? true,
      data,
      inputType,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  const createEvent = (type, init = {}) => {
    if (win && typeof win.Event === 'function') {
      try {
        return new win.Event(type, {
          bubbles: true,
          cancelable: false,
          composed: true,
          ...init
        });
      } catch (_) {}
    }
    return {
      type,
      bubbles: init.bubbles ?? true,
      cancelable: init.cancelable ?? false,
      composed: init.composed ?? true,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
  };

  // Optional clear previous value
  if (opts.clearFirst) {
    if (typeof targetEl.value === 'string') {
      targetEl.value = '';
    } else if (typeof targetEl.textContent === 'string') {
      targetEl.textContent = '';
    }
  }

  // Simulate typing character by character
  const chars = Array.from(textToType);
  for (const char of chars) {
    // keydown
    const downEv = createKeyboardEvent('keydown', char);
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(downEv);
    }

    // beforeinput
    const beforeInputEv = createInputEvent('beforeinput', char, 'insertText');
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(beforeInputEv);
    }

    // update value
    if (typeof targetEl.value === 'string') {
      targetEl.value += char;
    } else if (typeof targetEl.textContent === 'string') {
      targetEl.textContent += char;
    }

    // input
    const inputEv = createInputEvent('input', char, 'insertText');
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(inputEv);
    }

    // keyup
    const upEv = createKeyboardEvent('keyup', char);
    if (typeof targetEl.dispatchEvent === 'function') {
      targetEl.dispatchEvent(upEv);
    }

    if (opts.delay && opts.delay > 0) {
      await new Promise(r => setTimeout(r, opts.delay));
    }
  }

  // change event
  const changeEv = createEvent('change');
  if (typeof targetEl.dispatchEvent === 'function') {
    targetEl.dispatchEvent(changeEv);
  }

  if (opts.blurAfter && typeof targetEl.blur === 'function') {
    try {
      targetEl.blur();
    } catch (_) {}
  }

  return {
    success: true,
    action: 'type',
    target: {
      tagName: targetEl.tagName,
      id: targetEl.id || null
    },
    textTyped: textToType,
    value: targetEl.value ?? targetEl.textContent ?? textToType
  };
}

/**
 * Retrieves a credential secret from session storage or memory.
 */
async function getLocalSecret(alias) {
  if (!alias) return null;
  const key = String(alias);
  if (typeof chrome !== 'undefined' && chrome.storage?.session?.get) {
    try {
      const res = await chrome.storage.session.get([`secret_${key}`, key]);
      if (res && res[`secret_${key}`]) {
        return res[`secret_${key}`];
      }
      if (res && res[key]) {
        return res[key];
      }
    } catch (_) {}
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
    try {
      const res = await new Promise((resolve) => {
        try {
          chrome.storage.local.get([key, `secret_${key}`, 'secrets'], (data) => {
            if (chrome.runtime?.lastError) resolve(null);
            else resolve(data);
          });
        } catch (_) {
          resolve(null);
        }
      });
      if (res) {
        if (res[key] != null) return String(res[key]);
        if (res[`secret_${key}`] != null) return String(res[`secret_${key}`]);
        if (res.secrets && res.secrets[key] != null) return String(res.secrets[key]);
      }
    } catch (_) {}
  }
  return null;
}

// Centralized Action Schema resolution
const SCHEMA_SYMBOL = Symbol.for('__PRIVACY_LENS_ACTION_SCHEMA__');

function resolveActionSchema() {
  if (typeof globalThis !== 'undefined' && globalThis[SCHEMA_SYMBOL]) {
    return globalThis[SCHEMA_SYMBOL];
  }
  if (typeof window !== 'undefined' && window[SCHEMA_SYMBOL]) {
    return window[SCHEMA_SYMBOL];
  }
  if (typeof Set !== 'undefined' && Set[SCHEMA_SYMBOL]) {
    return Set[SCHEMA_SYMBOL];
  }
  return null;
}

const DEFAULT_ALLOWED_ACTION_TYPES = new Set([
  'click',
  'type',
  'input',
  'scroll',
  'wait',
  'navigate',
  'fill_secret',
  'done'
]);

function getEffectiveAllowedTypes() {
  const schema = resolveActionSchema();
  return schema ? schema.ALLOWED_ACTION_TYPES : DEFAULT_ALLOWED_ACTION_TYPES;
}

/**
 * Centralized navigation URL validator enforcing strict scheme allowlist in content script.
 * Delegates to centralized action schema if present, with standalone fallback.
 * Permitted schemes: 'http:', 'https:' only.
 * Explicitly rejected dangerous schemes: 'javascript:', 'data:', 'file:', 'chrome:', 'chrome-extension:'.
 *
 * @param {string} url - Destination URL string
 * @returns {{ valid: boolean, error?: string, url?: string }}
 */
function validateNavigationUrl(url) {
  const schema = resolveActionSchema();
  if (schema && typeof schema.validateNavigationUrl === 'function') {
    return schema.validateNavigationUrl(url);
  }

  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'navigate action requires a url string' };
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return { valid: false, error: 'navigate action requires a non-empty url string' };
  }

  const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'chrome:', 'chrome-extension:']);
  const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

  const schemeMatch = trimmed.match(/^([a-zA-Z0-9+.-]+):/);
  if (schemeMatch && FORBIDDEN_SCHEMES.has(schemeMatch[1].toLowerCase() + ':')) {
    return { valid: false, error: `Forbidden URL scheme "${schemeMatch[1].toLowerCase()}:": navigation blocked for security` };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return { valid: false, error: `Invalid URL format: "${trimmed}"` };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (FORBIDDEN_SCHEMES.has(protocol)) {
    return { valid: false, error: `Forbidden URL scheme "${protocol}": navigation blocked for security` };
  }

  if (!ALLOWED_SCHEMES.has(protocol)) {
    return { valid: false, error: `Unsupported URL scheme "${protocol}": only http: and https: are allowed` };
  }

  return { valid: true, url: parsed.href };
}

/**
 * Validates an action item schema in content script using centralized action schema.
 * Prevents validation drift between action executor and content script.
 *
 * @param {object} action - Action item to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAction(action) {
  const schema = resolveActionSchema();
  if (schema && typeof schema.validateAction === 'function') {
    return schema.validateAction(action);
  }

  if (!action || typeof action !== 'object') {
    return { valid: false, error: 'Action must be an object' };
  }
  const rawType = action.type || action.action;
  if (!rawType || typeof rawType !== 'string') {
    return { valid: false, error: 'Missing or invalid action type' };
  }
  const type = rawType.toLowerCase();
  const allowed = getEffectiveAllowedTypes();
  if (!allowed.has(type)) {
    return { valid: false, error: `Unsupported action type: "${type}"` };
  }
  const selector = action.target_selector || action.selector || action.target?.selector;
  if (selector && typeof selector === 'string' && /<script|javascript:|on\w+=/i.test(selector)) {
    return { valid: false, error: `Potentially unsafe script injection in selector: "${selector}"` };
  }
  const bbox = action.target_bbox || action.bbox || action.target?.bbox;
  if (bbox !== undefined && bbox !== null) {
    if (!Array.isArray(bbox) || bbox.length < 4) {
      return { valid: false, error: 'target_bbox must be an array of at least 4 numbers' };
    }
    const [x, y, w, h] = bbox.map(Number);
    if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h) || x < 0 || y < 0 || w < 0 || h < 0) {
      return { valid: false, error: 'target_bbox values must be valid non-negative numbers' };
    }
  }
  if (type === 'fill_secret') {
    const key = action.secret_key || action.secret_alias || action.secretKey;
    if (!key || typeof key !== 'string') {
      return { valid: false, error: 'fill_secret requires a valid secret_key alias' };
    }
  }
  if (type === 'navigate') {
    const url = action.url || action.target_url;
    const urlValidation = validateNavigationUrl(url);
    if (!urlValidation.valid) {
      return urlValidation;
    }
  }
  return { valid: true };
}

/**
 * Executes secret fill from the local extension vault.
 * Raw secret values NEVER leave the client browser.
 */
async function executeFillSecret(params = {}) {
  const secretKey = params.secret_key || params.secret_alias || params.secretKey;
  if (!secretKey) {
    throw new Error('fill_secret action requires a secret_key alias');
  }

  const secretValue = await getLocalSecret(secretKey);
  if (secretValue === null || secretValue === undefined) {
    throw new Error(`Vault Error: Secret "${secretKey}" not found in local credential vault`);
  }

  const targetEl = resolveTarget(params);
  if (!targetEl) {
    throw new Error(`Target element not found for fill_secret: ${JSON.stringify(params)}`);
  }

  const fillResult = await executeType(targetEl, secretValue, {
    ...params,
    allowSensitive: true,
    force: true
  });

  return {
    success: true,
    action: 'fill_secret',
    target: fillResult.target,
    secret_key: secretKey,
    filled: true
  };
}

/**
 * Executes browser navigation to a validated destination URL in content script.
 */
async function executeNavigate(params = {}) {
  const rawUrl = params.url || params.target_url;
  const urlValidation = validateNavigationUrl(rawUrl);
  if (!urlValidation.valid) {
    throw new Error(`Navigation rejected: ${urlValidation.error}`);
  }

  const validUrl = urlValidation.url;
  let navigated = false;

  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.update === 'function') {
    const tabId = params.tabId ?? params.tab_id;
    if (tabId != null) {
      await chrome.tabs.update(tabId, { url: validUrl });
    } else {
      await chrome.tabs.update({ url: validUrl });
    }
    navigated = true;
  } else if (typeof window !== 'undefined' && window.location) {
    if (typeof window.location.assign === 'function') {
      window.location.assign(validUrl);
    } else {
      window.location.href = validUrl;
    }
    navigated = true;
  } else if (typeof globalThis !== 'undefined' && globalThis.location) {
    if (typeof globalThis.location.assign === 'function') {
      globalThis.location.assign(validUrl);
    } else {
      globalThis.location.href = validUrl;
    }
    navigated = true;
  }

  return {
    success: true,
    action: 'navigate',
    url: validUrl,
    navigated
  };
}

/**
 * Dispatches an action object to the appropriate executor.
 *
 * @param {Object} action - Action definition (type: 'click'|'scroll'|'type'|'fill_secret'|'navigate'|'wait', params...)
 * @returns {Promise<Object>} Execution result
 */
async function executeAction(action, options = {}) {
  if (!action) {
    throw new Error('No action provided');
  }

  const actionData = (action.action && typeof action.action === 'object')
    ? { ...action.action, ...action }
    : action;

  const valResult = validateAction(actionData);
  if (!valResult.valid) {
    throw new Error(`Action schema validation failed: ${valResult.error}`);
  }

  const rawType = actionData.type || actionData.action || action.type;
  const type = String(rawType).toLowerCase();

  switch (type) {
    case 'click':
      return await executeClick(actionData, options);
    case 'scroll':
      return await executeScroll(actionData);
    case 'type':
    case 'input':
      return await executeType(actionData, undefined, options);
    case 'fill_secret':
      return await executeFillSecret(actionData);
    case 'navigate':
      return await executeNavigate(actionData);
    case 'submit': {
      const targetEl = resolveTarget(actionData, options);
      if (targetEl && typeof targetEl.submit === 'function') {
        targetEl.submit();
        return { success: true, action: 'submit' };
      }
      return await executeClick(actionData, options);
    }
    case 'press':
    case 'key': {
      const key = actionData.key || 'Enter';
      const targetEl = resolveTarget(actionData, options) || document.activeElement || document.body;
      if (targetEl && typeof targetEl.dispatchEvent === 'function') {
        targetEl.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
        targetEl.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }));
      }
      return { success: true, action: 'press', key };
    }
    case 'hover':
    case 'mouse_move': {
      const targetEl = resolveTarget(actionData, options);
      if (targetEl && typeof targetEl.dispatchEvent === 'function') {
        targetEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        targetEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        return { success: true, action: 'hover' };
      }
      return { success: false, action: 'hover', error: 'Target not found' };
    }
    case 'wait':
      const ms = Number(actionData.delay_ms || actionData.ms || 500);
      await new Promise(r => setTimeout(r, ms));
      return { success: true, action: 'wait', duration: ms };
    case 'done':
      return { success: true, action: 'done', reason: actionData.reason || '' };
    default:
      throw new Error(`Unsupported action type: "${type}"`);
  }
}

/**
 * Executes a single action or a list of actions sequentially.
 *
 * @param {Object|Array<Object>} actions - Action or array of actions
 * @param {object} [options={}]
 * @returns {Promise<Object>} Execution result(s)
 */
async function executeActions(actions, options = {}) {
  if (!actions) {
    throw new Error('No actions provided');
  }

  const list = Array.isArray(actions) ? actions : [actions];
  if (list.length === 0) {
    return { success: true, results: [] };
  }

  const maxActions = options.maxActions ?? 10;
  if (list.length > maxActions) {
    throw new Error(`Exceeded max actions per response cap: ${list.length} > ${maxActions}`);
  }

  const results = [];
  for (const act of list) {
    const res = await executeAction(act, options);
    results.push(res);
  }

  return results.length === 1 ? results[0] : { success: true, results };
}


// PII Highlight state management
let piiHighlightState = {
  active: false,
  count: 0,
  cleanupFn: null
};

/**
 * Returns current PII highlight status.
 */
function getPiiHighlightStatus() {
  return {
    success: true,
    active: piiHighlightState.active,
    count: piiHighlightState.count
  };
}

/**
 * Clears all active PII highlights from the DOM.
 */
function clearPiiHighlights() {
  if (typeof document === 'undefined') {
    return { success: true, active: false, count: 0 };
  }

  if (typeof piiHighlightState.cleanupFn === 'function') {
    piiHighlightState.cleanupFn();
    piiHighlightState.cleanupFn = null;
  }

  const container = document.getElementById('privacy-lens-pii-container');
  if (container) {
    container.remove();
  }

  const highlightedElements = document.querySelectorAll('[data-privacy-lens-highlight]');
  for (const el of highlightedElements) {
    if (el.dataset.privacyLensPrevOutline !== undefined) {
      el.style.outline = el.dataset.privacyLensPrevOutline;
      delete el.dataset.privacyLensPrevOutline;
    } else {
      el.style.outline = '';
    }
    if (el.dataset.privacyLensPrevOffset !== undefined) {
      el.style.outlineOffset = el.dataset.privacyLensPrevOffset;
      delete el.dataset.privacyLensPrevOffset;
    } else {
      el.style.outlineOffset = '';
    }
    if (el.dataset.privacyLensPrevShadow !== undefined) {
      el.style.boxShadow = el.dataset.privacyLensPrevShadow;
      delete el.dataset.privacyLensPrevShadow;
    } else {
      el.style.boxShadow = '';
    }
    el.removeAttribute('data-privacy-lens-highlight');
  }

  piiHighlightState.active = false;
  piiHighlightState.count = 0;
  return { success: true, active: false, count: 0 };
}

/**
 * Applies visual highlight borders and floating badges to recognized PII fields.
 * @param {Array<{ selector?: string, bbox?: number[], category?: string }>} regions
 */
function applyPiiHighlights(regions = []) {
  if (typeof document === 'undefined') {
    return { success: false, active: false, count: 0 };
  }

  clearPiiHighlights();

  const CATEGORY_CONFIG = {
    password: { border: '#ef4444', label: 'PASSWORD' },
    card: { border: '#f97316', label: 'CREDIT CARD' },
    ssn: { border: '#8b5cf6', label: 'SSN / TAX' },
    pin: { border: '#ec4899', label: 'PIN / OTP' },
    otp: { border: '#ec4899', label: 'OTP' },
    tax: { border: '#8b5cf6', label: 'TAX ID' },
    email: { border: '#3b82f6', label: 'EMAIL' },
    phone: { border: '#06b6d4', label: 'PHONE' },
    default: { border: '#e11d48', label: 'SENSITIVE PII' }
  };

  const container = document.createElement('div');
  container.id = 'privacy-lens-pii-container';
  container.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 0; pointer-events: none; z-index: 2147483647;';
  if (document.body) {
    document.body.appendChild(container);
  }

  const matchedEntries = [];

  for (const region of regions) {
    let el = null;
    if (region.selector) {
      try {
        el = document.querySelector(region.selector);
      } catch (e) {
        el = null;
      }
    }
    if (!el && Array.isArray(region.bbox) && region.bbox.length === 4) {
      const [x, y, w, h] = region.bbox;
      el = document.elementFromPoint(x + w / 2, y + h / 2);
    }
    if (!el) continue;

    const catKey = (region.category || 'default').toLowerCase();
    const config = CATEGORY_CONFIG[catKey] || CATEGORY_CONFIG.default;

    if (!el.hasAttribute('data-privacy-lens-highlight')) {
      el.dataset.privacyLensPrevOutline = el.style.outline || '';
      el.dataset.privacyLensPrevOffset = el.style.outlineOffset || '';
      el.dataset.privacyLensPrevShadow = el.style.boxShadow || '';
      el.setAttribute('data-privacy-lens-highlight', catKey);

      el.style.setProperty('outline', `2px solid ${config.border}`, 'important');
      el.style.setProperty('outline-offset', '2px', 'important');
      el.style.setProperty('box-shadow', `0 0 10px ${config.border}88`, 'important');
    }

    const badge = document.createElement('div');
    badge.className = 'privacy-lens-pii-badge';
    badge.textContent = `🔒 ${config.label}`;
    badge.style.cssText = `
      position: absolute;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.2;
      color: #ffffff;
      background-color: ${config.border};
      border-radius: 4px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
      white-space: nowrap;
      pointer-events: none;
      z-index: 2147483647;
    `;
    container.appendChild(badge);
    matchedEntries.push({ el, badge });
  }

  function updateBadgePositions() {
    for (const { el, badge } of matchedEntries) {
      const rect = el.getBoundingClientRect();
      const top = rect.top + (window.scrollY || 0) - 18;
      const left = rect.left + (window.scrollX || 0);
      badge.style.top = `${Math.max(0, top)}px`;
      badge.style.left = `${Math.max(0, left)}px`;
    }
  }

  updateBadgePositions();
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('scroll', updateBadgePositions, { passive: true });
    window.addEventListener('resize', updateBadgePositions, { passive: true });

    piiHighlightState.cleanupFn = () => {
      window.removeEventListener('scroll', updateBadgePositions);
      window.removeEventListener('resize', updateBadgePositions);
    };
  }

  piiHighlightState.active = true;
  piiHighlightState.count = matchedEntries.length;

  return { success: true, active: true, count: matchedEntries.length };
}

/**
 * Toggles PII highlights on/off.
 */
function togglePiiHighlights(regions = []) {
  if (piiHighlightState.active) {
    return clearPiiHighlights();
  }
  return applyPiiHighlights(regions);
}

// Register message listener for requests from background or popup scripts
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'PING') {
      sendResponse({ success: true, pong: true });
      return true;
    }

    if (
      message &&
      (message.type === 'EXTRACT_DOM_SKELETON' ||
       message.type === 'extractDomSkeleton' ||
       message.action === 'extractDomSkeleton' ||
       message.action === 'EXTRACT_DOM_SKELETON' ||
       message.type === 'GET_DOM_SKELETON')
    ) {
      try {
        const root = (typeof document !== 'undefined' ? document.body : null);
        const skeleton = extractDomSkeleton(root, message.options || {});
        const elements = flattenSkeleton(skeleton);
        const viewport = typeof window !== 'undefined' ? {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX || 0,
          scrollY: window.scrollY || 0
        } : { width: 0, height: 0, scrollX: 0, scrollY: 0 };

        sendResponse({
          success: true,
          skeleton,
          tree: skeleton,
          elements,
          viewport
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message || String(err)
        });
      }
      return true;
    }

    if (
      message &&
      (message.type === 'ACTION_EXECUTE' ||
       message.type === 'EXECUTE_ACTION' ||
       message.action === 'ACTION_EXECUTE' ||
       message.action === 'EXECUTE_ACTION')
    ) {
      (async () => {
        try {
          let payload;
          if (message.actions && Array.isArray(message.actions)) {
            payload = message.actions;
          } else if (message.action && typeof message.action === 'object') {
            payload = message.action;
          } else if (message.params && typeof message.params === 'object') {
            payload = message.params;
          } else if (message.payload && typeof message.payload === 'object') {
            payload = message.payload;
          } else {
            const { type, ...rest } = message;
            payload = { type: (message.action && typeof message.action === 'string') ? message.action : type, ...rest };
          }

          const opts = message.options || {};
          const res = await executeActions(payload, opts);
          sendResponse({ success: true, ...res });
        } catch (err) {
          sendResponse({
            success: false,
            error: err.message || String(err)
          });
        }
      })();
      return true;
    }

    if (message && message.type === 'APPLY_PII_HIGHLIGHT') {
      const res = applyPiiHighlights(message.regions || []);
      sendResponse(res);
      return true;
    }

    if (message && message.type === 'CLEAR_PII_HIGHLIGHT') {
      const res = clearPiiHighlights();
      sendResponse(res);
      return true;
    }

    if (message && message.type === 'GET_PII_HIGHLIGHT_STATUS') {
      const res = getPiiHighlightStatus();
      sendResponse(res);
      return true;
    }

    if (message && message.type === 'TOGGLE_PII_HIGHLIGHT') {
      const res = togglePiiHighlights(message.regions || []);
      sendResponse(res);
      return true;
    }
  });
}

// Expose on window for in-page access or testing
if (typeof window !== 'undefined') {
  window.extractDomSkeleton = extractDomSkeleton;
  window.flattenSkeleton = flattenSkeleton;
  window.getCssSelector = getCssSelector;
  window.getXPath = getXPath;
  window.resolveTarget = resolveTarget;
  window.isSensitiveField = isSensitiveField;
  window.executeClick = executeClick;
  window.executeScroll = executeScroll;
  window.executeType = executeType;
  window.executeAction = executeAction;
  window.executeActions = executeActions;
  window.validateAction = validateAction;
  window.validateNavigationUrl = validateNavigationUrl;
  window.ALLOWED_ACTION_TYPES = getEffectiveAllowedTypes();
  window.executeNavigate = executeNavigate;
  window.executeFillSecret = executeFillSecret;
  window.getLocalSecret = getLocalSecret;
  window.applyPiiHighlights = applyPiiHighlights;
  window.clearPiiHighlights = clearPiiHighlights;
  window.getPiiHighlightStatus = getPiiHighlightStatus;
  window.togglePiiHighlights = togglePiiHighlights;
}

// Module export for Node.js / unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractDomSkeleton,
    flattenSkeleton,
    getCssSelector,
    getXPath,
    getRole,
    getAriaLabel,
    getElementText,
    isInteractive,
    getBoundingBox,
    isElementVisible,
    getCenterCoordinates,
    resolveTarget,
    isSensitiveField,
    executeClick,
    executeScroll,
    executeType,
    executeAction,
    executeActions,
    validateAction,
    validateNavigationUrl,
    ALLOWED_ACTION_TYPES: getEffectiveAllowedTypes(),
    executeNavigate,
    executeFillSecret,
    getLocalSecret,
    applyPiiHighlights,
    clearPiiHighlights,
    getPiiHighlightStatus,
    togglePiiHighlights
  };
}

