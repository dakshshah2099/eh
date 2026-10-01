// Background service worker for Privacy Lens Agent
import { downscaleImage, calculateTargetDimensions } from './downscale.js';
import { sendPayloadToServer, buildPayload, DEFAULT_SERVER_URL } from './transport.js';
import { executePipeline } from './pipeline.js';
import { defaultProfiler, LatencyProfiler, LATENCY_BUDGET_MS } from './profiler.js';
import { detectSensitiveDomElements } from './dom_detector.js';
import {
  classifyActionRisk,
  enforceConfirmationGate,
  ConfirmationRequired,
  ConfirmationDeclined
} from './action_policy.js';

let agentState = {
  isRunning: false,
  lastStartedAt: null,
  lastStoppedAt: null
};

// Pending confirmation handler for risky actions (Ticket 06)
let pendingConfirmationResolver = null;
let currentPendingConfirmation = null;

// Offscreen document singleton management
let creatingOffscreenPromise = null;

export async function ensureOffscreenDocument(path = 'offscreen/offscreen.html') {
  if (typeof chrome.offscreen === 'undefined') {
    return false;
  }
  const offscreenUrl = chrome.runtime.getURL(path);
  if (chrome.runtime.getContexts) {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts.length > 0) {
      return true;
    }
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return true;
  }

  try {
    creatingOffscreenPromise = chrome.offscreen.createDocument({
      url: path,
      reasons: ['BLOBS', 'WORKERS'],
      justification: 'Offscreen canvas downscaling and ONNX Web / WebGPU vision processing'
    });
    await creatingOffscreenPromise;
    return true;
  } catch (err) {
    if (!err.message?.includes('Only a single offscreen document may be created')) {
      console.warn('[Background] Failed to create offscreen document:', err);
    }
    return false;
  } finally {
    creatingOffscreenPromise = null;
  }
}

let lastBgCaptureTime = 0;
const MIN_BG_CAPTURE_GAP_MS = 650;

/**
 * Captures the visible tab of the specified window or tab with quota protection.
 * @param {number|null} [tabId=null] - Tab ID to capture. If provided, ensures tab is active in its window.
 * @param {object} [options={}] - Capture options (format: 'jpeg'|'png', quality: 0-100)
 * @returns {Promise<string>} Base64 Data URL of the raw screenshot
 */
export async function captureTab(tabId = null, options = {}) {
  let windowId = null;

  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        windowId = tab.windowId;
        if (!tab.active) {
          await chrome.tabs.update(tabId, { active: true });
        }
      }
    } catch (err) {
      console.warn(`[Background] Failed to inspect tabId ${tabId}:`, err);
    }
  }

  const captureOptions = {
    format: options?.format === 'png' ? 'png' : 'jpeg'
  };
  if (captureOptions.format === 'jpeg') {
    captureOptions.quality = typeof options?.quality === 'number' ? options.quality : 85;
  }

  // Throttle to respect MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
  const elapsed = Date.now() - lastBgCaptureTime;
  if (elapsed < MIN_BG_CAPTURE_GAP_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_BG_CAPTURE_GAP_MS - elapsed));
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      lastBgCaptureTime = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, captureOptions);
      return dataUrl;
    } catch (err) {
      if (err.message?.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') && attempt < 3) {
        console.warn(`[Background] Capture rate limit hit, retrying after ${attempt * 600}ms...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 600));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Captures the specified tab (or active tab) and downscales it to <= maxDimension preserving aspect ratio.
 * @param {number|null} [tabId=null] - Target tab ID
 * @param {number} [maxDimension=768] - Maximum length of the longest side (<768px target)
 * @param {object} [options={}] - Options (format, quality, useOffscreen)
 * @returns {Promise<{ dataUrl: string, base64: string, width: number, height: number, originalWidth: number, originalHeight: number, scale: number }>}
 */
export async function captureAndDownscale(tabId = null, maxDimension = 768, options = {}) {
  const rawDataUrl = await captureTab(tabId, options);

  // If Offscreen document explicitly requested or OffscreenCanvas is missing
  if (options?.useOffscreen && typeof chrome.offscreen !== 'undefined') {
    await ensureOffscreenDocument();
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          target: 'offscreen',
          type: 'OFFSCREEN_DOWNSCALE',
          imageSource: rawDataUrl,
          maxDimension,
          options
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response);
          } else {
            reject(new Error(response?.error || 'Offscreen downscale failed'));
          }
        }
      );
    });
  }

// Fast direct path via service worker canvas utility
  return await downscaleImage(rawDataUrl, maxDimension, options);
}

/**
 * Ensures the content script is loaded in the target tab.
 * Dynamically injects content_script.js via chrome.scripting if missing.
 * @param {number} tabId
 */
export async function ensureContentScript(tabId) {
  if (!tabId || typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (err) {
    if (
      err.message?.includes('Receiving end does not exist') ||
      err.message?.includes('Could not establish connection')
    ) {
      try {
        console.log(`[Background] Injecting content script into tab ${tabId}...`);
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content_script.js']
        });
        await new Promise(resolve => setTimeout(resolve, 150));
      } catch (e) {
        console.warn(`[Background] Failed to dynamically inject content script into tab ${tabId}:`, e.message);
      }
    }
  }
}

/**
 * Requests DOM skeleton extraction from the specified or active tab's content script.
 * @param {number|null} [tabId=null] - Target tab ID
 * @param {object} [options={}] - Extraction options (inViewportOnly, etc.)
 * @returns {Promise<object>} Extracted DOM skeleton response
 */
export async function extractDomSkeletonFromTab(tabId = null, options = {}) {
  let targetTabId = tabId;
  if (targetTabId == null) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTabId = tabs[0]?.id;
  }
  if (targetTabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }
  if (targetTabId == null) {
    throw new Error('No target tab specified or active tab found');
  }
  await ensureContentScript(targetTabId);
  return await chrome.tabs.sendMessage(targetTabId, {
    type: 'EXTRACT_DOM_SKELETON',
    options
  });
}

/**
 * Sends an action execution request to the specified or active tab's content script.
 * @param {number|null} [tabId=null] - Target tab ID
 * @param {object|Array} [action={}] - Action or list of actions to execute
 * @returns {Promise<object>} Action execution result
 */
export async function executeActionInTab(tabId = null, action = {}, options = {}) {
  let targetTabId = tabId;
  if (targetTabId == null) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTabId = tabs[0]?.id;
  }
  if (targetTabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }
  if (targetTabId == null) {
    throw new Error('No target tab specified or active tab found');
  }
  await ensureContentScript(targetTabId);
  return await chrome.tabs.sendMessage(targetTabId, {
    type: 'ACTION_EXECUTE',
    action,
    options
  });
}

/**
 * Captures current or specified tab, runs full perception & redaction pipeline,
 * and sends sanitized payload to the FastAPI plan endpoint.
 *
 * @param {object} [params={}]
 * @returns {Promise<{ success: boolean, plan: object, payload: object }>}
 */
export async function captureAndSendPlan({
  task = '',
  tabId = null,
  serverUrl = DEFAULT_SERVER_URL,
  redactionMap = [],
  maxDimension = 768,
  captureOptions = {},
  domOptions = {},
  enableVisionInference,
  ...rest
} = {}) {
  let targetTabId = tabId;
  if (targetTabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }
  if (targetTabId == null) {
    throw new Error('No target tab specified or active tab found');
  }

  return await executePipeline({
    task,
    tabId: targetTabId,
    serverUrl,
    maxDimension,
    captureOptions,
    domOptions,
    sendToServer: true,
    ...(enableVisionInference !== undefined ? { enableVisionInference } : {}),
    ...rest
  });
}

/**
 * Waits for DOM mutations and layout changes to settle.
 * @param {number|null} [tabId=null]
 * @param {number} [settleMs=300]
 * @returns {Promise<boolean>}
 */
export async function waitForDomSettle(tabId = null, settleMs = 300) {
  const delay = Math.max(50, settleMs);
  await new Promise(resolve => setTimeout(resolve, delay));
  return true;
}

/**
 * Broadcasts a task status message to runtime listeners (e.g. popup).
 * Safely suppresses errors if popup or listeners are not open.
 * @param {object} message
 */
export function broadcastTaskMessage(message) {
  try {
    if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
      const res = chrome.runtime.sendMessage(message, () => {
        if (chrome.runtime?.lastError) {
          // Suppress error if popup / receiver is not listening
        }
      });
      if (res && typeof res.catch === 'function') {
        res.catch(() => {});
      }
    }
  } catch (_) {}
}

export const MAX_STATUS_EVENTS = 50;

/**
 * Returns session storage provider (falling back to local if session unavailable).
 * @returns {object|null}
 */
export function getSessionStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    return chrome.storage.session;
  }
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return null;
}

/**
 * Updates agentState in memory, local storage, and session storage.
 * @param {object} [partial={}]
 * @returns {Promise<object>} Updated agentState
 */
export async function updateAgentState(partial = {}) {
  Object.assign(agentState, partial);
  if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
    try {
      await chrome.storage.local.set({ agentState });
    } catch (err) {
      console.warn('[Background] Failed to save agentState to local storage:', err);
    }
  }
  try {
    const session = getSessionStorage();
    if (session && typeof session.set === 'function') {
      await session.set({ agentState });
    }
  } catch (err) {
    console.warn('[Background] Failed to sync agentState to session storage:', err);
  }
  return agentState;
}

/**
 * Extracts a sanitized, non-PII target locator string from an action.
 * Ensures field text/values are NEVER included.
 *
 * @param {object} act
 * @returns {string}
 */
export function getSanitizedActionTarget(act) {
  if (!act || typeof act !== 'object') return '';
  if (act.target_selector) return String(act.target_selector);
  if (act.selector) return String(act.selector);
  if (act.element_id) return `#${act.element_id}`;
  if (act.target_element_id) return `#${act.target_element_id}`;
  if (act.element_type) return `<${act.element_type}>`;
  if (act.target) {
    if (typeof act.target === 'string') return act.target;
    if (act.target.selector) return String(act.target.selector);
    if (act.target.element_id) return `#${act.target.element_id}`;
    if (act.target.element_type) return `<${act.target.element_type}>`;
  }
  if (act.secret_key || act.secret_alias) return `vault:${act.secret_key || act.secret_alias}`;
  if (act.url) {
    try {
      const u = new URL(act.url);
      return u.hostname + (u.pathname !== '/' ? u.pathname : '');
    } catch (_) {
      return String(act.url);
    }
  }
  if (act.point) return `(${act.point.x}, ${act.point.y})`;
  if (act.x !== undefined && act.y !== undefined) return `(${act.x}, ${act.y})`;
  if (act.deltaY !== undefined) return `deltaY: ${act.deltaY}`;
  if (act.target_bbox || act.bbox) {
    const b = act.target_bbox || act.bbox;
    if (Array.isArray(b)) return `[${b.slice(0, 4).join(',')}]`;
  }
  return '';
}

/**
 * Clears the session status event log.
 */
export async function clearStatusLog() {
  try {
    const session = getSessionStorage();
    if (session && typeof session.set === 'function') {
      await session.set({ agentStatusLog: [] });
    }
  } catch (err) {
    console.warn('[Background] Failed to clear status log:', err);
  }
}

/**
 * Records and broadcasts an AGENT_STATUS event.
 * Saves recent events to session storage.
 *
 * @param {object} eventPayload
 * @returns {Promise<object>} Recorded payload
 */
export async function recordAgentStatus(eventPayload) {
  const payload = {
    type: 'AGENT_STATUS',
    timestamp: Date.now(),
    ...eventPayload
  };

  // Broadcast to active popup / listeners
  broadcastTaskMessage(payload);

  // Store recent N events in session storage
  try {
    const session = getSessionStorage();
    if (session && typeof session.get === 'function') {
      const data = await session.get(['agentStatusLog']);
      const current = Array.isArray(data?.agentStatusLog) ? data.agentStatusLog : [];
      current.push(payload);
      if (current.length > MAX_STATUS_EVENTS) {
        current.splice(0, current.length - MAX_STATUS_EVENTS);
      }
      if (typeof session.set === 'function') {
        await session.set({ agentStatusLog: current });
      }
    }
  } catch (err) {
    console.warn('[Background] Failed to record status in session storage:', err);
  }

  return payload;
}


/**
 * Autonomous agent loop: captures state, gets plan, executes action(s),
 * waits for DOM to settle, recaptures, and loops until task is complete or max steps reached.
 *
 * @param {number|object} [tabId=null] - Target tab ID or options object
 * @param {string} [task=''] - Goal description
 * @param {object} [options={}] - Loop options (maxSteps, domSettleDelay, serverUrl, etc.)
 * @returns {Promise<object>} Loop result summary
 */
let activeLoopPromise = null;

export async function startLoop(tabId = null, task = '', options = {}) {
  const executeLoop = async () => {
    let targetTabId = tabId;
    let targetTask = task;
    let opts = options || {};

    if (typeof tabId === 'object' && tabId !== null && task === '') {
      opts = tabId;
      targetTabId = opts.tabId ?? null;
      targetTask = opts.task || '';
    }

    if (targetTabId == null) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTabId = tabs[0]?.id;
      if (targetTabId == null) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = activeTab?.id;
      }
    }
    if (targetTabId == null) {
      throw new Error('No target tab specified or active tab found');
    }

    const maxSteps = opts.maxSteps ?? opts.max_steps ?? 10;
    const domSettleDelay = opts.domSettleDelay ?? opts.dom_settle_delay ?? 600;
    const serverUrl = opts.serverUrl || DEFAULT_SERVER_URL;
    const redactionMap = opts.redactionMap || [];
    const onStep = opts.onStep;

    const sessionId = opts.sessionId || opts.session_id || `tab_${targetTabId}`;
    const taskId = opts.taskId || opts.task_id || `task_${Date.now()}`;

    await ensureOffscreenDocument();
    await ensureState();
    await clearStatusLog();
    agentState.isRunning = true;
    agentState.currentTabId = targetTabId;
    agentState.currentTask = targetTask;
    agentState.currentTaskId = taskId;
    agentState.currentSessionId = sessionId;
    agentState.stepCount = 0;
    agentState.lastStartedAt = Date.now();
    agentState.lastStoppedAt = null;
    agentState.lastCompletionStatus = null;
    agentState.lastCompletionReason = null;
    agentState.lastError = null;
    await updateAgentState();

    console.log(`[Background] Autonomous loop started for tab ${targetTabId}, task: "${targetTask}", maxSteps: ${maxSteps}`);

  const history = [];
  let step = 0;
  let taskComplete = false;
  let completionReason = '';
  let lastPlan = null;

  try {
    while (agentState.isRunning && step < maxSteps) {
      if (opts.signal?.aborted) {
        console.log('[Background] Loop aborted via signal');
        break;
      }

      step++;
      agentState.stepCount = step;
      await updateAgentState();

      console.log(`[Background] Loop step ${step}/${maxSteps} starting...`);

      const stepStartedEvent = {
        event: 'STEP_STARTED',
        step,
        maxSteps,
        taskId,
        sessionId,
        message: `Step ${step}/${maxSteps} started`
      };
      await recordAgentStatus(stepStartedEvent);
      if (typeof opts.onStatus === 'function') {
        try { opts.onStatus(stepStartedEvent); } catch (_) {}
      }

      // 1. Recapture screen + DOM skeleton and get plan from server
      let currentLlmConfig = null;
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
          const stored = await chrome.storage.local.get(['llmConfig', 'llmMode']);
          if (stored?.llmConfig) {
            currentLlmConfig = stored.llmConfig;
          }
        }
      } catch (_) {}

      const activeLlm = currentLlmConfig || opts.llmConfig;
      const clientHasApiKey = Boolean(activeLlm?.apiKey || opts.apiKey || opts.api_key);

      const planResult = await captureAndSendPlan({
        task: targetTask,
        tabId: targetTabId,
        serverUrl,
        redactionMap,
        maxDimension: opts.maxDimension ?? 768,
        captureOptions: opts.captureOptions ?? {},
        domOptions: opts.domOptions ?? {},
        llmConfig: activeLlm,
        serverKeyMode: opts.serverKeyMode !== undefined ? opts.serverKeyMode : (!clientHasApiKey),
        session_id: sessionId,
        task_id: taskId,
        step,
        ...(opts.enableVisionInference !== undefined ? { enableVisionInference: opts.enableVisionInference } : {}),
        ...(opts.visionOptions ? { visionOptions: opts.visionOptions } : {}),
        ...(opts.runVisionInference ? { runVisionInference: opts.runVisionInference } : {}),
        ...opts
      });

      lastPlan = planResult.plan;

      const stepRecord = {
        step,
        timestamp: Date.now(),
        plan: lastPlan,
        payload: planResult.payload || null,
        planResult,
        timings: planResult.timings || null,
        total_client_ms: planResult.timings?.total_client_ms ?? null,
        actionResults: []
      };

      if (typeof onStep === 'function') {
        try {
          await onStep({ step, plan: lastPlan, planResult, history });
        } catch (_) {}
      }

      // Check for immediate completion: only when there are NO non-done executable actions
      const nonDoneActions = Array.isArray(lastPlan?.actions)
        ? lastPlan.actions.filter(a => {
            const t = (a?.type || a?.action || '').toLowerCase();
            return t && t !== 'done';
          })
        : [];

      if (nonDoneActions.length === 0 && (lastPlan?.task_complete || lastPlan?.actions?.some(a => (a?.type || a?.action || '').toLowerCase() === 'done'))) {
        console.log(`[Background] Task complete signaled at step ${step} with no remaining actions.`);
        taskComplete = true;
        const doneAction = lastPlan?.actions?.find(a => (a?.type || a?.action || '').toLowerCase() === 'done');
        completionReason = doneAction?.reason || lastPlan?.reason || 'Task complete';
        stepRecord.actionResults.push({
          success: true,
          action: 'done',
          reason: completionReason
        });
        history.push(stepRecord);
        break;
      }

      const actions = lastPlan?.actions;
      if (!Array.isArray(actions) || actions.length === 0) {
        console.log(`[Background] No actions provided in plan at step ${step}. Ending loop.`);
        history.push(stepRecord);
        break;
      }

      // 2. Execute plan action(s) in tab
      for (const act of actions) {
        if (!agentState.isRunning || opts.signal?.aborted) {
          break;
        }

        const actType = (act?.type || act?.action || '').toLowerCase();
        if (actType === 'done') {
          console.log(`[Background] 'done' action reached at step ${step}.`);
          taskComplete = true;
          completionReason = act?.reason || lastPlan?.reason || '';
          stepRecord.actionResults.push({
            success: true,
            action: 'done',
            reason: completionReason
          });
          break;
        }

        const target = getSanitizedActionTarget(act);
        const actionDecidedEvent = {
          event: 'ACTION_DECIDED',
          step,
          actionType: actType,
          target,
          taskId,
          sessionId,
          message: target ? `Action decided: ${actType} on ${target}` : `Action decided: ${actType}`
        };
        await recordAgentStatus(actionDecidedEvent);
        if (typeof opts.onStatus === 'function') {
          try { opts.onStatus(actionDecidedEvent); } catch (_) {}
        }

        // Ticket 07 / C7 / Ticket 06: Action-risk policy classification & confirmation gate
        const policyContext = {
          task: targetTask,
          ui_elements: lastPlan?.ui_elements || planResult?.payload?.ui_elements || [],
          step,
          currentOrigin: typeof targetTabId === 'number' ? (await chrome.tabs.get(targetTabId).catch(() => null))?.url : ''
        };
        classifyActionRisk(act, policyContext);

        if (act.requires_confirmation && !act.confirmed) {
          // If onConfirmAction callback was provided in opts (e.g. test harness), use it
          if (typeof opts.onConfirmAction === 'function') {
            await enforceConfirmationGate(act, opts);
          } else if (!opts.interactiveConfirmation && (opts.throwOnConfirmationRequired || (typeof process !== 'undefined' && Boolean(process?.versions?.node)))) {
            // In Node.js unit tests or headless runs without live interactive UI, throw ConfirmationRequired
            await enforceConfirmationGate(act, opts);
          } else {
            // Live extension mode: broadcast CONFIRM_ACTION_REQUIRED to popup and wait
            console.log(`[Background] Pausing loop for risky action approval at step ${step}:`, act);
            const plainSummary = act.reason || act.description || `Execute ${actType} on ${target || 'page'}`;
            const confirmEvent = {
              type: 'CONFIRM_ACTION_REQUIRED',
              action: act,
              actionType: actType,
              target: target || 'page',
              summary: plainSummary,
              step,
              taskId,
              sessionId
            };

            currentPendingConfirmation = confirmEvent;
            try {
              const session = getSessionStorage();
              if (session && typeof session.set === 'function') {
                await session.set({ pendingConfirmation: confirmEvent });
              }
            } catch (_) {}

            broadcastTaskMessage(confirmEvent);

            const approved = await new Promise((resolve) => {
              pendingConfirmationResolver = resolve;
            });

            currentPendingConfirmation = null;
            pendingConfirmationResolver = null;
            try {
              const session = getSessionStorage();
              if (session && typeof session.remove === 'function') {
                await session.remove('pendingConfirmation');
              }
            } catch (_) {}

            if (!approved) {
              console.log(`[Background] Risky action declined by user at step ${step}. Exiting loop.`);
              agentState.isRunning = false;
              agentState.lastStoppedAt = Date.now();
              agentState.lastCompletionStatus = 'stopped';
              agentState.lastCompletionReason = 'User declined action confirmation';
              await updateAgentState();
              broadcastTaskMessage({
                type: 'TASK_STOPPED',
                stepCount: step,
                reason: 'User declined action confirmation'
              });
              break;
            }

            act.confirmed = true;
          }
        }

        console.log(`[Background] Executing action at step ${step}:`, act);
        const actionOptions = {
          scale: planResult?.payload?.image?.scale ?? planResult?.scale ?? 1.0,
          image: planResult?.payload?.image ?? null,
          viewport: planResult?.payload?.viewport ?? null,
          coordinate_space: planResult?.payload?.coordinate_space ?? 'viewport',
          task: targetTask
        };
        const actionResult = await executeActionInTab(targetTabId, act, actionOptions);
        stepRecord.actionResults.push(actionResult);

        const actionExecutedEvent = {
          event: 'ACTION_EXECUTED',
          step,
          actionType: actType,
          target,
          success: Boolean(actionResult?.success),
          taskId,
          sessionId,
          message: target
            ? `Action executed: ${actType} on ${target} (${actionResult?.success ? 'success' : 'failed'})`
            : `Action executed: ${actType} (${actionResult?.success ? 'success' : 'failed'})`
        };
        await recordAgentStatus(actionExecutedEvent);
        if (typeof opts.onStatus === 'function') {
          try { opts.onStatus(actionExecutedEvent); } catch (_) {}
        }
      }

      history.push(stepRecord);

      if (!taskComplete && lastPlan?.task_complete) {
        taskComplete = true;
        completionReason = lastPlan?.reason || 'Plan marked task as complete';
      }

      if (taskComplete || !agentState.isRunning || opts.signal?.aborted) {
        break;
      }

      // 3. Wait for DOM to settle before recapturing
      await waitForDomSettle(targetTabId, domSettleDelay);
    }
  } catch (err) {
    console.error(`[Background] Error during autonomous loop step ${step}:`, err);
    const loopErrorEvent = {
      event: 'LOOP_ERROR',
      step,
      error: err?.message || String(err),
      taskId,
      sessionId,
      message: `Error at step ${step}: ${err?.message || String(err)}`
    };
    await recordAgentStatus(loopErrorEvent);
    if (typeof opts.onStatus === 'function') {
      try { opts.onStatus(loopErrorEvent); } catch (_) {}
    }
    throw err;
  } finally {
    agentState.isRunning = false;
    agentState.lastStoppedAt = Date.now();
    agentState.lastCompletionStatus = taskComplete ? 'done' : (step >= maxSteps ? 'exhausted' : 'stopped');
    agentState.lastCompletionReason = taskComplete ? completionReason : (step >= maxSteps ? 'Max steps reached' : 'Agent stopped by user');
    await updateAgentState();
    console.log(`[Background] Autonomous loop finished at step ${step}. Task complete: ${taskComplete}`);
  }

  // Notify listeners (popup, etc.) of completion or exhaustion
  if (taskComplete) {
    const doneStatusEvent = {
      event: 'TASK_DONE',
      step,
      stepCount: step,
      steps: step,
      reason: completionReason,
      taskId,
      sessionId,
      message: completionReason ? `✓ Done — ${completionReason}` : '✓ Done'
    };
    await recordAgentStatus(doneStatusEvent);
    if (typeof opts.onStatus === 'function') {
      try { opts.onStatus(doneStatusEvent); } catch (_) {}
    }

    const donePayload = {
      type: 'TASK_DONE',
      stepCount: step,
      steps: step,
      reason: completionReason,
      taskId,
      sessionId
    };
    if (typeof opts.onTaskDone === 'function') {
      try { opts.onTaskDone(donePayload); } catch (_) {}
    }
    broadcastTaskMessage(donePayload);
  } else if (step >= maxSteps) {
    const exhaustedStatusEvent = {
      event: 'TASK_EXHAUSTED',
      step,
      stepCount: step,
      steps: step,
      maxSteps,
      taskId,
      sessionId,
      message: '⚠ Step limit reached'
    };
    await recordAgentStatus(exhaustedStatusEvent);
    if (typeof opts.onStatus === 'function') {
      try { opts.onStatus(exhaustedStatusEvent); } catch (_) {}
    }

    const exhaustedPayload = {
      type: 'TASK_EXHAUSTED',
      stepCount: step,
      steps: step,
      maxSteps,
      taskId,
      sessionId
    };
    if (typeof opts.onTaskExhausted === 'function') {
      try { opts.onTaskExhausted(exhaustedPayload); } catch (_) {}
    }
    broadcastTaskMessage(exhaustedPayload);
  } else {
    // Loop stopped early via stopLoop / takeback
    const stoppedStatusEvent = {
      event: 'TASK_STOPPED',
      step,
      stepCount: step,
      steps: step,
      maxSteps,
      taskId,
      sessionId,
      message: '⏹ Agent stopped — control returned to user'
    };
    await recordAgentStatus(stoppedStatusEvent);
    if (typeof opts.onStatus === 'function') {
      try { opts.onStatus(stoppedStatusEvent); } catch (_) {}
    }

    const stoppedPayload = {
      type: 'TASK_STOPPED',
      stepCount: step,
      steps: step,
      maxSteps,
      taskId,
      sessionId,
      reason: 'Agent stopped by user'
    };
    if (typeof opts.onTaskStopped === 'function') {
      try { opts.onTaskStopped(stoppedPayload); } catch (_) {}
    }
    broadcastTaskMessage(stoppedPayload);
  }

  return {
    success: true,
    taskComplete,
    reason: completionReason,
    stepsExecuted: step,
    maxStepsReached: !taskComplete && step >= maxSteps,
    finalPlan: lastPlan,
    sessionId,
    taskId,
    history
  };
  };

  activeLoopPromise = executeLoop();
  try {
    return await activeLoopPromise;
  } finally {
    activeLoopPromise = null;
  }
}

/**
 * Stops any currently running autonomous agent loop.
 * Exits at the next safe checkpoint (after the current action completes).
 * @returns {Promise<{ success: boolean, isRunning: boolean }>}
 */
export async function stopLoop() {
  await ensureState();
  if (!agentState.isRunning && !activeLoopPromise) {
    return { success: true, isRunning: false, message: 'Agent already stopped' };
  }
  agentState.isRunning = false;
  agentState.lastStoppedAt = Date.now();
  agentState.lastCompletionStatus = 'stopped';
  agentState.lastCompletionReason = 'Agent stopped by user';
  await updateAgentState();

  if (!activeLoopPromise) {
    const stoppedStatusEvent = {
      event: 'TASK_STOPPED',
      step: agentState.stepCount || 0,
      stepCount: agentState.stepCount || 0,
      steps: agentState.stepCount || 0,
      maxSteps: 10,
      taskId: agentState.currentTaskId || null,
      sessionId: agentState.currentSessionId || null,
      message: '⏹ Agent stopped — control returned to user'
    };
    await recordAgentStatus(stoppedStatusEvent);
    broadcastTaskMessage({
      type: 'TASK_STOPPED',
      stepCount: agentState.stepCount || 0,
      steps: agentState.stepCount || 0,
      maxSteps: 10,
      reason: 'Agent stopped by user'
    });
  }

  console.log('[Background] Agent loop stopped at:', new Date(agentState.lastStoppedAt).toISOString());
  return { success: true, isRunning: false };
}

// Profiler & latency telemetry helpers
export function getLatencySummary() {
  return defaultProfiler.getSummary();
}

export function getLatencyRecords() {
  return defaultProfiler.getRecords();
}

export function clearLatencyMetrics() {
  defaultProfiler.clear();
  return { success: true };
}

export function logLatencySummary() {
  return defaultProfiler.logSummary();
}

// Expose globally on service worker scope for debugging and direct access
globalThis.captureAndDownscale = captureAndDownscale;
globalThis.captureTab = captureTab;
globalThis.downscaleImage = downscaleImage;
globalThis.calculateTargetDimensions = calculateTargetDimensions;
globalThis.extractDomSkeletonFromTab = extractDomSkeletonFromTab;
globalThis.executeActionInTab = executeActionInTab;
globalThis.sendPayloadToServer = sendPayloadToServer;
globalThis.buildPayload = buildPayload;
globalThis.captureAndSendPlan = captureAndSendPlan;
globalThis.waitForDomSettle = waitForDomSettle;
globalThis.startLoop = startLoop;
globalThis.stopLoop = stopLoop;
globalThis.executePipeline = executePipeline;
globalThis.profiler = defaultProfiler;
globalThis.LatencyProfiler = LatencyProfiler;
globalThis.getLatencySummary = getLatencySummary;
globalThis.getLatencyRecords = getLatencyRecords;
globalThis.clearLatencyMetrics = clearLatencyMetrics;
globalThis.logLatencySummary = logLatencySummary;
globalThis.classifyActionRisk = classifyActionRisk;
globalThis.enforceConfirmationGate = enforceConfirmationGate;
globalThis.ConfirmationRequired = ConfirmationRequired;
globalThis.ConfirmationDeclined = ConfirmationDeclined;
globalThis.broadcastTaskMessage = broadcastTaskMessage;
globalThis.recordAgentStatus = recordAgentStatus;
globalThis.clearStatusLog = clearStatusLog;
globalThis.getSanitizedActionTarget = getSanitizedActionTarget;
globalThis.getSessionStorage = getSessionStorage;
globalThis.updateAgentState = updateAgentState;
globalThis.MAX_STATUS_EVENTS = MAX_STATUS_EVENTS;

export {
  downscaleImage,
  calculateTargetDimensions,
  sendPayloadToServer,
  buildPayload,
  executePipeline,
  defaultProfiler as profiler,
  LatencyProfiler,
  LATENCY_BUDGET_MS,
  DEFAULT_SERVER_URL,
  classifyActionRisk,
  enforceConfirmationGate,
  ConfirmationRequired,
  ConfirmationDeclined
};

// Initialize state from storage
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(async () => {
    agentState = {
      isRunning: false,
      lastStartedAt: null,
      lastStoppedAt: null,
      currentTask: null,
      currentTaskId: null,
      currentTabId: null,
      stepCount: 0,
      lastCompletionStatus: null,
      lastCompletionReason: null,
      lastError: null
    };
    await updateAgentState();
    console.log('[Background] Extension installed, agentState initialized.');
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(async () => {
    await ensureState();
    if (agentState.isRunning) {
      agentState.isRunning = false;
      agentState.lastStoppedAt = Date.now();
    }
    await updateAgentState();
    console.log('[Background] Extension startup, agentState:', agentState);
  });
}

// Sync in-memory state on service worker wake
export async function ensureState() {
  const session = getSessionStorage();
  if (session && typeof session.get === 'function') {
    try {
      const sData = await session.get('agentState');
      if (sData?.agentState) {
        agentState = { ...agentState, ...sData.agentState };
        return agentState;
      }
    } catch (_) {}
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
    const data = await chrome.storage.local.get('agentState');
    if (data?.agentState) {
      agentState = { ...agentState, ...data.agentState };
    }
  }
  return agentState;
}

// Agent loop control functions (aliases for startLoop and stopLoop)
export async function startAgentLoop(params = {}) {
  const tabId = params.tabId ?? null;
  const task = params.task ?? agentState.currentTask ?? '';
  return await startLoop(tabId, task, params);
}

export async function stopAgentLoop() {
  return await stopLoop();
}

globalThis.startAgentLoop = startAgentLoop;
globalThis.stopAgentLoop = stopAgentLoop;

// Message dispatcher
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Ignore messages targeted to offscreen document
    if (message.target === 'offscreen') {
      return false;
    }

  (async () => {
    try {
      switch (message.type) {
        case 'GET_STATUS': {
          const state = await ensureState();
          if (!activeLoopPromise && state.isRunning) {
            state.isRunning = false;
            agentState.isRunning = false;
            await updateAgentState();
          }
          sendResponse({ success: true, state });
          break;
        }
        case 'START_AUTONOMOUS_LOOP':
        case 'START_LOOP':
        case 'START_AGENT_LOOP':
        case 'START_AGENT': {
          // Guard: prevent duplicate start races when loop is actively executing
          if (activeLoopPromise) {
            sendResponse({ success: true, isRunning: true, message: 'Agent already running' });
            break;
          }

          const tabId = message.tabId ?? null;
          const task = message.task || message.taskDescription || '';
          const options = Object.assign({}, message.options || message, { interactiveConfirmation: true });

          // Optimistic early state update in storage and memory before async loop init
          agentState.isRunning = true;
          agentState.lastStartedAt = Date.now();
          agentState.lastStoppedAt = null;
          agentState.currentTabId = tabId;
          agentState.currentTask = task;
          agentState.stepCount = 0;
          agentState.lastError = null;
          agentState.lastCompletionStatus = null;
          agentState.lastCompletionReason = null;
          await updateAgentState();

          if (message.async || message.type === 'START_AUTONOMOUS_LOOP') {
            startLoop(tabId, task, options).catch(async err => {
              console.error('[Background] Async loop error:', err);
              agentState.isRunning = false;
              agentState.lastStoppedAt = Date.now();
              agentState.lastError = err?.message || String(err);
              agentState.lastCompletionStatus = 'error';
              agentState.lastCompletionReason = err?.message || String(err);
              await updateAgentState();
            });
            sendResponse({ success: true, isRunning: true, message: 'Loop started' });
          } else {
            const res = await startLoop(tabId, task, options);
            sendResponse(res);
          }
          break;
        }
        case 'STOP_AUTONOMOUS_LOOP':
        case 'STOP_LOOP':
        case 'STOP_AGENT_LOOP':
        case 'STOP_AGENT': {
          if (pendingConfirmationResolver) {
            pendingConfirmationResolver(false);
          }
          const res = await stopLoop();
          sendResponse(res);
          break;
        }
        case 'CONFIRM_ACTION_APPROVED': {
          if (typeof pendingConfirmationResolver === 'function') {
            pendingConfirmationResolver(true);
            sendResponse({ success: true, approved: true });
          } else {
            sendResponse({ success: false, error: 'No confirmation pending' });
          }
          break;
        }
        case 'CONFIRM_ACTION_REJECTED': {
          if (typeof pendingConfirmationResolver === 'function') {
            pendingConfirmationResolver(false);
            sendResponse({ success: true, approved: false });
          } else {
            sendResponse({ success: false, error: 'No confirmation pending' });
          }
          break;
        }
        case 'CAPTURE_SCREEN': {
          const dataUrl = await captureTab(message.tabId, message.options);
          sendResponse({ success: true, dataUrl });
          break;
        }
        case 'CAPTURE_AND_DOWNSCALE': {
          const result = await captureAndDownscale(
            message.tabId,
            message.maxDimension ?? 768,
            message.options ?? {}
          );
          sendResponse({ success: true, ...result });
          break;
        }
        case 'EXTRACT_DOM_SKELETON': {
          let targetTabId = message.tabId;
          if (targetTabId == null) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTabId = activeTab?.id;
          }
          if (targetTabId == null) {
            sendResponse({ success: false, error: 'No active tab found' });
            break;
          }
          const res = await chrome.tabs.sendMessage(targetTabId, {
            type: 'EXTRACT_DOM_SKELETON',
            options: message.options
          });
          sendResponse(res);
          break;
        }
        case 'TOGGLE_PII_HIGHLIGHT': {
          let targetTabId = message.tabId;
          if (targetTabId == null) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTabId = activeTab?.id;
          }
          if (targetTabId == null) {
            sendResponse({ success: false, error: 'No active tab found' });
            break;
          }
          await ensureContentScript(targetTabId);
          const currentStatus = await chrome.tabs.sendMessage(targetTabId, { type: 'GET_PII_HIGHLIGHT_STATUS' }).catch(() => null);
          if (currentStatus?.active) {
            const clearRes = await chrome.tabs.sendMessage(targetTabId, { type: 'CLEAR_PII_HIGHLIGHT' }).catch(() => null);
            sendResponse({ success: true, active: false, count: 0 });
          } else {
            const skeletonResp = await chrome.tabs.sendMessage(targetTabId, { type: 'EXTRACT_DOM_SKELETON' });
            const sensitiveElements = detectSensitiveDomElements(skeletonResp.skeleton || skeletonResp.tree || skeletonResp);
            const applyRes = await chrome.tabs.sendMessage(targetTabId, {
              type: 'APPLY_PII_HIGHLIGHT',
              regions: sensitiveElements
            });
            sendResponse({
              success: true,
              active: true,
              count: sensitiveElements.length,
              regions: sensitiveElements
            });
          }
          break;
        }
        case 'GET_PII_HIGHLIGHT_STATUS': {
          let targetTabId = message.tabId;
          if (targetTabId == null) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTabId = activeTab?.id;
          }
          if (targetTabId == null) {
            sendResponse({ success: false, active: false });
            break;
          }
          await ensureContentScript(targetTabId);
          const statusResp = await chrome.tabs.sendMessage(targetTabId, { type: 'GET_PII_HIGHLIGHT_STATUS' }).catch(() => null);
          sendResponse({ success: true, active: Boolean(statusResp?.active), count: statusResp?.count || 0 });
          break;
        }
        case 'GET_RUNTIME_STATUS':
        case 'INIT_ONNX': {
          await ensureOffscreenDocument();
          chrome.runtime.sendMessage(
            { target: 'offscreen', type: message.type === 'INIT_ONNX' ? 'INIT_ONNX' : 'CHECK_RUNTIME' },
            (response) => {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                sendResponse(response || { success: false, error: 'No response from offscreen document' });
              }
            }
          );
          break;
        }
        case 'SEND_PLAN_PAYLOAD':
        case 'SEND_PAYLOAD_TO_SERVER': {
          const payload = message.payload ? buildPayload(message.payload) : buildPayload(message);
          const serverUrl = message.serverUrl || DEFAULT_SERVER_URL;
          const plan = await sendPayloadToServer(payload, serverUrl, message.fetchOptions || {});
          sendResponse({ success: true, plan, payload });
          break;
        }
        case 'RUN_PIPELINE':
        case 'EXECUTE_PIPELINE': {
          const res = await executePipeline(message);
          sendResponse(res);
          break;
        }
        case 'CAPTURE_AND_SEND_PLAN':
        case 'PLAN_STEP': {
          const res = await captureAndSendPlan(message);
          sendResponse(res);
          break;
        }
        case 'ACTION_EXECUTE':
        case 'EXECUTE_ACTION': {
          let targetTabId = message.tabId;
          if (targetTabId == null) {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTabId = activeTab?.id;
          }
          if (targetTabId == null) {
            sendResponse({ success: false, error: 'No active tab found' });
            break;
          }
          const res = await chrome.tabs.sendMessage(targetTabId, {
            type: 'ACTION_EXECUTE',
            action: message.action,
            actions: message.actions,
            params: message.params
          });
          sendResponse(res);
          break;
        }
        case 'GET_LATENCY_METRICS':
        case 'GET_LATENCY_SUMMARY':
        case 'GET_PROFILING_SUMMARY': {
          sendResponse({
            success: true,
            summary: getLatencySummary(),
            records: getLatencyRecords()
          });
          break;
        }
        case 'CLEAR_LATENCY_METRICS': {
          clearLatencyMetrics();
          sendResponse({ success: true });
          break;
        }
        case 'LOG_LATENCY_SUMMARY': {
          const summary = logLatencySummary();
          sendResponse({ success: true, summary });
          break;
        }
        case 'SET_LLM_MODE': {
          const mode = message.mode === 'cloud' ? 'cloud' : 'local';
          await chrome.storage.local.set({ llmMode: mode });
          console.log('[Background] LLM mode set to:', mode);
          sendResponse({ success: true, mode });
          break;
        }
        case 'GET_LLM_CONFIG': {
          const data = await chrome.storage.local.get(['llmConfig', 'llmMode']);
          sendResponse({ success: true, llmConfig: data.llmConfig || null, llmMode: data.llmMode || 'local' });
          break;
        }
        case 'SET_LLM_CONFIG': {
          const cfg = message.config || {};
          await chrome.storage.local.set({ llmConfig: cfg });
          console.log('[Background] LLM config saved:', cfg.provider, cfg.model);
          sendResponse({ success: true });
          break;
        }
        case 'GET_STATUS_LOG': {
          const session = getSessionStorage();
          const data = session && typeof session.get === 'function'
            ? await session.get(['agentStatusLog'])
            : { agentStatusLog: [] };
          sendResponse({ success: true, log: data?.agentStatusLog || [] });
          break;
        }
        case 'CLEAR_STATUS_LOG': {
          await clearStatusLog();
          sendResponse({ success: true });
          break;
        }
        default:
          sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
          break;
      }
    } catch (err) {
      console.error('[Background] Error processing message:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  // Return true to indicate asynchronous response
  return true;
  });
}
