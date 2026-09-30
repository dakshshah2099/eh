/**
 * Privacy Lens Agent - Action Risk Policy & Confirmation Gate
 * Ticket 07 / C7: Action-risk policy: low/medium/high + confirmation gate
 *
 * Implements a policy-validator layer between planner output and executor dispatch.
 * Classifies actions into three tiers:
 * - low: scroll, wait, read (safe, non-mutating / observational - pass through)
 * - medium: type, navigate, benign clicks (interaction/state mutation - log & pass through)
 * - high: actions whose target selector, element text, task string, or reason field
 *         matches payment/purchase/delete/send-message/change-password patterns
 *         (critical side-effects - must be confirmed by caller before execution)
 */

export class ConfirmationRequired extends Error {
  constructor(message = 'Confirmation required for high-risk action') {
    super(message);
    this.name = 'ConfirmationRequired';
    this.requires_confirmation = true;
    this.code = 'CONFIRMATION_REQUIRED';
  }
}

export class ConfirmationDeclined extends ConfirmationRequired {
  constructor(message = 'Action confirmation declined') {
    super(message);
    this.name = 'ConfirmationDeclined';
    this.requires_confirmation = true;
    this.code = 'CONFIRMATION_DECLINED';
  }
}

// Aliases for compatibility
export const ConfirmationRequiredError = ConfirmationRequired;
export const ConfirmationDeclinedError = ConfirmationDeclined;

export const RISK_TIERS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
};

/**
 * Patterns representing sensitive/high-risk actions.
 */
export const HIGH_RISK_PATTERNS = {
  payment: /(?:payment|checkout|place[\s_-]?order|buy(?:[\s_-]?now)?|subscribe|subscription|charge|billing|invoice|transaction|credit[\s_-]?card|debit[\s_-]?card|card[\s_-]?number|cvv|cvc|security[\s_-]?code|submit[\s_-]?payment|complete[\s_-]?order|complete[\s_-]?purchase|wire[\s_-]?transfer|pay(?:\b|[\s_.-]|$))/i,
  delete: /(?:delete|destroy|purge|erase|wipe|discard|trash|remove[\s_-]?(?:account|user|card|item|all)?|cancel[\s_-]?(?:account|subscription|membership|order|service|plan)|close[\s_-]?account|terminate[\s_-]?account|deactivate[\s_-]?account)/i,
  send: /(?:(?:^|[\s_.-])send(?:[\s_.-]|$)|send[\s_-]?(?:message|email|mail|dm|chat|sms|funds|money)|submit[\s_-]?(?:message|post)|post[\s_-]?(?:comment|reply|tweet)|tweet|publish|dispatch)/i,
  change_password: /(?:(?:change|update|reset|modify|new|set)[\s_-]?(?:password|passwd|credentials|secret)|security[\s_-]?settings|two[\s_-]?factor|2fa|mfa)/i
};

/**
 * Normalizes input text into a clean string.
 * @param {any} val
 * @returns {string}
 */
function cleanText(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return '';
}

/**
 * Classifies an action's risk tier (low, medium, high) and determines if confirmation is required.
 * Adds `risk` and `requires_confirmation` fields directly to the action object.
 *
 * @param {object} action - Action definition (type, target_selector, text, reason, etc.)
 * @param {object|string} [context={}] - Contextual signals ({ task, ui_elements, element, ... }) or task string
 * @returns {{ risk: 'low'|'medium'|'high', requires_confirmation: boolean, category?: string, match?: string }}
 */
export function classifyActionRisk(action, context = {}) {
  if (!action || typeof action !== 'object') {
    return { risk: RISK_TIERS.LOW, requires_confirmation: false };
  }

  const rawType = action.type || action.action || '';
  const type = String(rawType).toLowerCase().trim();

  // Tier 1: Low-risk actions (scroll, wait, read) always pass through without confirmation
  const LOW_RISK_TYPES = new Set(['scroll', 'wait', 'read', 'sleep', 'done']);
  if (LOW_RISK_TYPES.has(type)) {
    const result = { risk: RISK_TIERS.LOW, requires_confirmation: false };
    try {
      action.risk = RISK_TIERS.LOW;
      action.requires_confirmation = false;
    } catch (_) {}
    return result;
  }

  // Parse context
  const taskStr = typeof context === 'string'
    ? context
    : (context?.task || context?.taskDescription || context?.task_description || action.task || '');
  const uiElements = Array.isArray(context?.ui_elements)
    ? context.ui_elements
    : (Array.isArray(context?.uiElements) ? context.uiElements : []);

  // Collect candidate text signals from the action, target element, and context
  const candidateTexts = [];

  // 1. Target locators & selectors
  if (action.target_selector) candidateTexts.push(action.target_selector);
  if (action.selector) candidateTexts.push(action.selector);
  if (action.target_xpath) candidateTexts.push(action.target_xpath);
  if (action.xpath) candidateTexts.push(action.xpath);
  if (action.target_element_id) candidateTexts.push(action.target_element_id);
  if (action.element_id) candidateTexts.push(action.element_id);

  // 2. Action text payload & explicit target text
  if (action.text) candidateTexts.push(cleanText(action.text));
  if (action.value) candidateTexts.push(cleanText(action.value));
  if (action.target_text) candidateTexts.push(cleanText(action.target_text));
  if (action.element_text) candidateTexts.push(cleanText(action.element_text));

  // 3. Reason & description
  if (action.reason) candidateTexts.push(cleanText(action.reason));
  if (action.description) candidateTexts.push(cleanText(action.description));

  // 4. URL (for navigation actions)
  if (action.url) candidateTexts.push(cleanText(action.url));
  if (action.target_url) candidateTexts.push(cleanText(action.target_url));

  // 5. Secret key / alias (for fill_secret)
  if (action.secret_key) candidateTexts.push(cleanText(action.secret_key));
  if (action.secret_alias) candidateTexts.push(cleanText(action.secret_alias));

  // 6. Correlate with ui_elements (Ticket 01 / C1: read ui_elements for element semantics)
  const targetId = action.target_element_id || action.element_id;
  const targetSel = action.target_selector || action.selector;
  if (uiElements.length > 0) {
    for (const el of uiElements) {
      if (!el || typeof el !== 'object') continue;
      const idMatch = targetId && (el.id === targetId || el.element_id === targetId);
      const selMatch = targetSel && (el.selector === targetSel || el.target_selector === targetSel);
      let bboxMatch = false;
      if (action.target_bbox && el.bbox && Array.isArray(action.target_bbox) && Array.isArray(el.bbox)) {
        bboxMatch = Math.abs(action.target_bbox[0] - el.bbox[0]) < 10 && Math.abs(action.target_bbox[1] - el.bbox[1]) < 10;
      }
      if (idMatch || selMatch || bboxMatch) {
        if (el.label) candidateTexts.push(cleanText(el.label));
        if (el.text) candidateTexts.push(cleanText(el.text));
        if (el.category) candidateTexts.push(cleanText(el.category));
        if (el.name) candidateTexts.push(cleanText(el.name));
        if (el.aria_label) candidateTexts.push(cleanText(el.aria_label));
      }
    }
  }

  // 7. Inspect target DOM element if accessible
  let domEl = context?.element || action.element || null;
  if (!domEl && typeof document !== 'undefined') {
    if (targetId && typeof document.getElementById === 'function') {
      try { domEl = document.getElementById(targetId); } catch (_) {}
    }
    if (!domEl && targetSel && typeof document.querySelector === 'function') {
      try { domEl = document.querySelector(targetSel); } catch (_) {}
    }
  }
  if (domEl) {
    if (domEl.innerText) candidateTexts.push(cleanText(domEl.innerText));
    if (domEl.textContent) candidateTexts.push(cleanText(domEl.textContent));
    if (domEl.value) candidateTexts.push(cleanText(domEl.value));
    if (typeof domEl.getAttribute === 'function') {
      const aria = domEl.getAttribute('aria-label');
      if (aria) candidateTexts.push(cleanText(aria));
      const title = domEl.getAttribute('title');
      if (title) candidateTexts.push(cleanText(title));
      const name = domEl.getAttribute('name');
      if (name) candidateTexts.push(cleanText(name));
      const placeholder = domEl.getAttribute('placeholder');
      if (placeholder) candidateTexts.push(cleanText(placeholder));
    }
  }

  // 8. Task string
  if (taskStr) {
    candidateTexts.push(cleanText(taskStr));
  }

  // Check candidate texts against high-risk patterns
  let isHighRisk = false;
  let matchCategory = null;
  let matchText = null;

  for (const text of candidateTexts) {
    if (!text) continue;
    for (const [category, pattern] of Object.entries(HIGH_RISK_PATTERNS)) {
      if (pattern.test(text)) {
        isHighRisk = true;
        matchCategory = category;
        matchText = text;
        break;
      }
    }
    if (isHighRisk) break;
  }

  const risk = isHighRisk ? RISK_TIERS.HIGH : RISK_TIERS.MEDIUM;
  const requires_confirmation = isHighRisk;

  try {
    action.risk = risk;
    action.requires_confirmation = requires_confirmation;
  } catch (_) {}

  return {
    risk,
    requires_confirmation,
    ...(matchCategory ? { category: matchCategory, match: matchText } : {})
  };
}

/**
 * Enforces confirmation gate for high-risk actions.
 * Throws ConfirmationRequired error if no callback provided or ConfirmationDeclined if declined.
 * Low and medium risk actions pass through immediately.
 *
 * @param {object} action - Action object to gate
 * @param {object} [options={}] - Options containing onConfirmAction callback
 * @returns {Promise<boolean>} True if action is authorized to proceed
 */
export async function enforceConfirmationGate(action, options = {}) {
  if (!action || typeof action !== 'object') {
    return true;
  }

  // Ensure risk classification has occurred
  if (!action.risk || action.requires_confirmation === undefined) {
    classifyActionRisk(action, options.context || options);
  }

  // If already confirmed, pass through
  if (action.confirmed) {
    return true;
  }

  // Non-high-risk actions pass through
  if (!action.requires_confirmation) {
    return true;
  }

  // High-risk action: check confirmation callback
  const onConfirmAction = options.onConfirmAction || options.confirmAction || action.onConfirmAction;
  if (typeof onConfirmAction !== 'function') {
    const desc = action.reason || action.target_selector || action.text || action.type || 'high-risk action';
    throw new ConfirmationRequired(
      `ConfirmationRequired: Action of risk tier "${action.risk}" requires explicit confirmation: "${desc}"`
    );
  }

  const confirmed = await onConfirmAction(action);
  if (!confirmed) {
    throw new ConfirmationDeclined(
      `ConfirmationDeclined: Execution blocked because user declined confirmation for action: ${action.type}`
    );
  }

  action.confirmed = true;
  return true;
}

/**
 * Pre-executor wrapper that classifies risk, enforces confirmation gate, and dispatches to executor.
 *
 * @param {object} action - Action item
 * @param {Function} executeFn - Execution callback (e.g. executeAction)
 * @param {object} [options={}] - Execution options
 * @returns {Promise<any>} Execution result
 */
export async function executeWithRiskGate(action, executeFn, options = {}) {
  await enforceConfirmationGate(action, options);
  if (typeof executeFn === 'function') {
    return await executeFn(action, options);
  }
  return { success: true, action };
}
