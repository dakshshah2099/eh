// Background service worker for Privacy Lens Agent
import { downscaleImage, calculateTargetDimensions } from './downscale.js';
import { sendPayloadToServer, buildPayload, DEFAULT_SERVER_URL } from './transport.js';
import { executePipeline } from './pipeline.js';
import { defaultProfiler, LatencyProfiler, LATENCY_BUDGET_MS } from './profiler.js';

let agentState = {
  isRunning: false,
  lastStartedAt: null,
  lastStoppedAt: null
};

// Offscreen document singleton management
let creatingOffscreenPromise = null;

export async function ensureOffscreenDocument(path = 'offscreen.html') {
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

/**
 * Captures the visible tab of the specified window or tab.
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

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, captureOptions);
  return dataUrl;
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
 * Requests DOM skeleton extraction from the specified or active tab's content script.
 * @param {number|null} [tabId=null] - Target tab ID
 * @param {object} [options={}] - Extraction options (inViewportOnly, etc.)
 * @returns {Promise<object>} Extracted DOM skeleton response
 */
export async function extractDomSkeletonFromTab(tabId = null, options = {}) {
  let targetTabId = tabId;
  if (targetTabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }
  if (targetTabId == null) {
    throw new Error('No target tab specified or active tab found');
  }
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
export async function executeActionInTab(tabId = null, action = {}) {
  let targetTabId = tabId;
  if (targetTabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }
  if (targetTabId == null) {
    throw new Error('No target tab specified or active tab found');
  }
  return await chrome.tabs.sendMessage(targetTabId, {
    type: 'ACTION_EXECUTE',
    action
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
 * Autonomous agent loop: captures state, gets plan, executes action(s),
 * waits for DOM to settle, recaptures, and loops until task is complete or max steps reached.
 *
 * @param {number|object} [tabId=null] - Target tab ID or options object
 * @param {string} [task=''] - Goal description
 * @param {object} [options={}] - Loop options (maxSteps, domSettleDelay, serverUrl, etc.)
 * @returns {Promise<object>} Loop result summary
 */
export async function startLoop(tabId = null, task = '', options = {}) {
  let targetTabId = tabId;
  let targetTask = task;
  let opts = options || {};

  if (typeof tabId === 'object' && tabId !== null && task === '') {
    opts = tabId;
    targetTabId = opts.tabId ?? null;
    targetTask = opts.task || '';
  }

  if (targetTabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }
  if (targetTabId == null) {
    throw new Error('No target tab specified or active tab found');
  }

  const maxSteps = opts.maxSteps ?? opts.max_steps ?? 10;
  const domSettleDelay = opts.domSettleDelay ?? opts.dom_settle_delay ?? 300;
  const serverUrl = opts.serverUrl || DEFAULT_SERVER_URL;
  const redactionMap = opts.redactionMap || [];
  const onStep = opts.onStep;

  await ensureState();
  agentState.isRunning = true;
  agentState.currentTabId = targetTabId;
  agentState.currentTask = targetTask;
  agentState.stepCount = 0;
  agentState.lastStartedAt = Date.now();
  await chrome.storage.local.set({ agentState });

  console.log(`[Background] Autonomous loop started for tab ${targetTabId}, task: "${targetTask}", maxSteps: ${maxSteps}`);

  const history = [];
  let step = 0;
  let taskComplete = false;
  let lastPlan = null;

  try {
    while (agentState.isRunning && step < maxSteps) {
      if (opts.signal?.aborted) {
        console.log('[Background] Loop aborted via signal');
        break;
      }

      step++;
      agentState.stepCount = step;
      await chrome.storage.local.set({ agentState });

      console.log(`[Background] Loop step ${step}/${maxSteps} starting...`);

      // 1. Recapture screen + DOM skeleton and get plan from server
      const planResult = await captureAndSendPlan({
        task: targetTask,
        tabId: targetTabId,
        serverUrl,
        redactionMap,
        maxDimension: opts.maxDimension ?? 768,
        captureOptions: opts.captureOptions ?? {},
        domOptions: opts.domOptions ?? {}
      });

      lastPlan = planResult.plan;
      const stepRecord = {
        step,
        timestamp: Date.now(),
        plan: lastPlan,
        timings: planResult.timings || null,
        total_client_ms: planResult.timings?.total_client_ms ?? null,
        actionResults: []
      };

      if (typeof onStep === 'function') {
        try {
          await onStep({ step, plan: lastPlan, history });
        } catch (_) {}
      }

      // Check for completion
      if (lastPlan?.task_complete) {
        console.log(`[Background] Task complete signaled at step ${step}.`);
        taskComplete = true;
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
        console.log(`[Background] Executing action at step ${step}:`, act);
        const actionResult = await executeActionInTab(targetTabId, act);
        stepRecord.actionResults.push(actionResult);
      }

      history.push(stepRecord);

      if (!agentState.isRunning || opts.signal?.aborted) {
        break;
      }

      // 3. Wait for DOM to settle before recapturing
      await waitForDomSettle(targetTabId, domSettleDelay);
    }
  } catch (err) {
    console.error(`[Background] Error during autonomous loop step ${step}:`, err);
    throw err;
  } finally {
    agentState.isRunning = false;
    agentState.lastStoppedAt = Date.now();
    await chrome.storage.local.set({ agentState });
    console.log(`[Background] Autonomous loop finished at step ${step}. Task complete: ${taskComplete}`);
  }

  return {
    success: true,
    taskComplete,
    stepsExecuted: step,
    maxStepsReached: !taskComplete && step >= maxSteps,
    finalPlan: lastPlan,
    history
  };
}

/**
 * Stops any currently running autonomous agent loop.
 * @returns {Promise<{ success: boolean, isRunning: boolean }>}
 */
export async function stopLoop() {
  await ensureState();
  if (!agentState.isRunning) {
    return { success: true, isRunning: false, message: 'Agent already stopped' };
  }
  agentState.isRunning = false;
  agentState.lastStoppedAt = Date.now();
  await chrome.storage.local.set({ agentState });
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

export {
  downscaleImage,
  calculateTargetDimensions,
  sendPayloadToServer,
  buildPayload,
  executePipeline,
  defaultProfiler as profiler,
  LatencyProfiler,
  LATENCY_BUDGET_MS,
  DEFAULT_SERVER_URL
};

// Initialize state from storage
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(async () => {
    await chrome.storage.local.set({ agentState });
    console.log('[Background] Extension installed, agentState initialized.');
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(async () => {
    const data = await chrome.storage.local.get('agentState');
    if (data.agentState) {
      agentState = data.agentState;
    }
    console.log('[Background] Extension startup, agentState:', agentState);
  });
}

// Sync in-memory state on service worker wake
async function ensureState() {
  const data = await chrome.storage.local.get('agentState');
  if (data.agentState) {
    agentState = data.agentState;
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
          sendResponse({ success: true, state });
          break;
        }
        case 'START_LOOP':
        case 'START_AGENT_LOOP':
        case 'START_AGENT': {
          const tabId = message.tabId ?? null;
          const task = message.task || message.taskDescription || '';
          const options = message.options || message;
          if (message.async) {
            startLoop(tabId, task, options).catch(err => {
              console.error('[Background] Async loop error:', err);
            });
            sendResponse({ success: true, isRunning: true, message: 'Loop started in background' });
          } else {
            const res = await startLoop(tabId, task, options);
            sendResponse(res);
          }
          break;
        }
        case 'STOP_LOOP':
        case 'STOP_AGENT_LOOP':
        case 'STOP_AGENT': {
          const res = await stopLoop();
          sendResponse(res);
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
