/**
 * Privacy Lens Agent - Action Schema & Validation
 *
 * Centralized, canonical schema definitions and validators for agent actions.
 * Deduplicates validation between action executor and content script to prevent validation drift.
 */

/**
 * Canonical set of supported action types for the agent.
 * Mutating this set dynamically reflects across all consumers (executor, content script, tests).
 */
export const ALLOWED_ACTION_TYPES = new Set([
  'click',
  'type',
  'input',
  'scroll',
  'wait',
  'navigate',
  'fill_secret',
  'done',
  'submit',
  'press',
  'hover'
]);

/**
 * Centralized navigation URL validator enforcing strict scheme allowlist.
 * Permitted schemes: 'http:', 'https:' only.
 * Explicitly rejected dangerous schemes: 'javascript:', 'data:', 'file:', 'chrome:', 'chrome-extension:'.
 * Used identically by both validateAction and executeNavigate across executor and content script.
 *
 * @param {string} url - Destination URL string
 * @returns {{ valid: boolean, error?: string, url?: string }}
 */
export function validateNavigationUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'navigate action requires a url string' };
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return { valid: false, error: 'navigate action requires a non-empty url string' };
  }

  const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'chrome:', 'chrome-extension:']);
  const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

  // Check prefix scheme match for immediate rejection (defense against malformed/obfuscated schemes)
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
 * Validates an action object against canonical schema rules:
 * - valid action type present in ALLOWED_ACTION_TYPES
 * - target presence where required (click, fill_secret)
 * - target_bbox bounds and ranges (non-negative, length 4)
 * - confidence range (0.0 to 1.0)
 * - selector safety (no script/event handler injection)
 * - secret_key alias presence for fill_secret
 * - safe navigation url for navigate
 *
 * @param {object} action - Action item to validate
 * @returns {{ valid: boolean, error?: string }} Validation outcome
 */
export function validateAction(action) {
  if (!action || typeof action !== 'object') {
    return { valid: false, error: 'Action must be an object' };
  }

  const rawType = action.type || action.action;
  if (!rawType || typeof rawType !== 'string') {
    return { valid: false, error: 'Missing or invalid action type' };
  }

  const type = rawType.toLowerCase();
  if (!ALLOWED_ACTION_TYPES.has(type)) {
    return { valid: false, error: `Unsupported action type: "${type}"` };
  }

  // Confidence check if present
  if (action.confidence !== undefined && action.confidence !== null) {
    const conf = Number(action.confidence);
    if (isNaN(conf) || conf < 0.0 || conf > 1.0) {
      return { valid: false, error: `Action confidence must be between 0.0 and 1.0, got: ${action.confidence}` };
    }
  }

  // Selector safety check
  const selector = action.target_selector || action.selector || action.target?.selector;
  if (selector && typeof selector === 'string') {
    if (/<script|javascript:|on\w+=/i.test(selector)) {
      return { valid: false, error: `Potentially unsafe script injection in selector: "${selector}"` };
    }
  }

  // BBox validity check
  const bbox = action.target_bbox || action.bbox || action.target?.bbox || action.target?.target_bbox;
  if (bbox !== undefined && bbox !== null) {
    if (!Array.isArray(bbox) || bbox.length < 4) {
      return { valid: false, error: 'target_bbox must be an array of at least 4 numbers [x, y, w, h]' };
    }
    const [x, y, w, h] = bbox.map(Number);
    if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) {
      return { valid: false, error: 'target_bbox coordinates must be valid numbers' };
    }
    if (x < 0 || y < 0 || w < 0 || h < 0) {
      return { valid: false, error: 'target_bbox values cannot be negative' };
    }
  }

  // Target requirement check for target-dependent actions
  if (type === 'click' || type === 'fill_secret') {
    const hasTarget = Boolean(
      action.target_element_id ||
      action.element_id ||
      action.target_selector ||
      action.selector ||
      action.target_xpath ||
      action.xpath ||
      action.target_bbox ||
      action.bbox ||
      action.point ||
      action.target ||
      action.text ||
      action.label ||
      action.name ||
      action.reason
    );
    if (!hasTarget) {
      return { valid: false, error: `Action "${type}" requires a target locator (element_id, selector, bbox, or target description)` };
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

  // Risk policy fields validation if present (Ticket 07 / C7)
  if (action.risk !== undefined && action.risk !== null) {
    const r = String(action.risk).toLowerCase();
    if (!['low', 'medium', 'high'].includes(r)) {
      return { valid: false, error: `Invalid action risk tier: "${action.risk}"` };
    }
  }

  if (action.requires_confirmation !== undefined && action.requires_confirmation !== null) {
    if (typeof action.requires_confirmation !== 'boolean') {
      return { valid: false, error: 'requires_confirmation must be a boolean' };
    }
  }

  return { valid: true };
}

// Global registry hook for cross-context sharing (e.g. content_script VM sandbox or browser window)
const SCHEMA_SYMBOL = Symbol.for('__PRIVACY_LENS_ACTION_SCHEMA__');

const schemaExport = {
  ALLOWED_ACTION_TYPES,
  validateAction,
  validateNavigationUrl
};

if (typeof globalThis !== 'undefined') {
  globalThis[SCHEMA_SYMBOL] = schemaExport;
  globalThis.ALLOWED_ACTION_TYPES = ALLOWED_ACTION_TYPES;
  globalThis.validateAction = validateAction;
  globalThis.validateNavigationUrl = validateNavigationUrl;
}
if (typeof window !== 'undefined') {
  window[SCHEMA_SYMBOL] = schemaExport;
  window.ALLOWED_ACTION_TYPES = ALLOWED_ACTION_TYPES;
  window.validateAction = validateAction;
  window.validateNavigationUrl = validateNavigationUrl;
}
if (typeof Set !== 'undefined') {
  Set[SCHEMA_SYMBOL] = schemaExport;
}
