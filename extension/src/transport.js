/**
 * Client-to-Server Transport module for Privacy Lens Agent.
 * Bundles extracted DOM skeleton and downscaled screen capture into a normalized payload,
 * and posts it to the FastAPI planning server.
 */

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000/api/plan';
export const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8000/health';

/**
 * Validates and normalizes payload for the /api/plan endpoint.
 * Schema conforms to FastAPI PlanRequest:
 * {
 *   task: string,
 *   dom_skeleton: object | array,
 *   image_base64: string,
 *   viewport: { width: number, height: number, ... },
 *   redaction_map: Array<{ bbox: number[], category: string, source: string, confidence: number }>
 * }
 *
 * @param {object} options
 * @returns {object} Normalized payload conforming to server PlanRequest schema
 */
export function buildPayload(options = {}) {
  const task = options.task != null ? String(options.task) : '';
  if (!task.trim()) {
    console.warn('[Transport] Warning: task is empty');
  }

  const domSkeleton = options.dom_skeleton ?? options.domSkeleton ?? [];
  
  // Extract base64 string from data URL, downscale result object, or raw string
  let rawImage = options.image_base64 ?? options.imageBase64 ?? options.image ?? '';
  if (typeof rawImage === 'object' && rawImage !== null) {
    rawImage = rawImage.dataUrl || rawImage.base64 || '';
  }
  const imageBase64 = typeof rawImage === 'string' ? rawImage : String(rawImage || '');

  // Extract viewport
  const vp = options.viewport || {};
  const viewport = {
    width: typeof vp.width === 'number' ? vp.width : Number(vp.width) || 0,
    height: typeof vp.height === 'number' ? vp.height : Number(vp.height) || 0
  };
  if (typeof vp.devicePixelRatio === 'number') {
    viewport.devicePixelRatio = vp.devicePixelRatio;
  }
  if (typeof vp.scrollX === 'number') {
    viewport.scrollX = vp.scrollX;
  }
  if (typeof vp.scrollY === 'number') {
    viewport.scrollY = vp.scrollY;
  }

  // Redaction map (array of redaction bounding boxes / categories)
  const redactions = options.redaction_map ?? options.redactionMap ?? [];
  const redactionMap = Array.isArray(redactions)
    ? redactions.map((item) => ({
        bbox: Array.isArray(item.bbox) ? item.bbox.map(Number) : [0, 0, 0, 0],
        category: String(item.category || 'unknown'),
        source: String(item.source || 'client'),
        confidence: typeof item.confidence === 'number' ? item.confidence : 1.0
      }))
    : [];

  const uiElements = options.ui_elements ?? options.uiElements ?? [];

  // Ticket 06: Explicit coordinate space and image dimensions declaration
  const coordinateSpace = options.coordinate_space ?? options.coordinateSpace ?? 'viewport';
  const imgOpts = options.image || {};
  const imageMeta = {
    width: typeof imgOpts.width === 'number' ? imgOpts.width : (typeof options.imageWidth === 'number' ? options.imageWidth : viewport.width),
    height: typeof imgOpts.height === 'number' ? imgOpts.height : (typeof options.imageHeight === 'number' ? options.imageHeight : viewport.height),
    scale: typeof imgOpts.scale === 'number' ? imgOpts.scale : (typeof options.imageScale === 'number' ? options.imageScale : (typeof options.scale === 'number' ? options.scale : 1.0))
  };

  // Ticket 12 / B12: Wire popup LLM config directly into planning payload
  const llm = options.llmConfig || options.llm || {};
  const provider = options.provider ?? llm.provider;
  const model = options.model ?? llm.model;
  const baseUrl = options.base_url ?? options.baseUrl ?? llm.baseUrl;
  const apiKey = options.api_key ?? options.apiKey ?? llm.apiKey;
  const timestamp = typeof options.timestamp === 'number' ? options.timestamp : Date.now() / 1000.0;

  return {
    task,
    dom_skeleton: domSkeleton,
    image_base64: imageBase64,
    viewport,
    coordinate_space: coordinateSpace,
    image: imageMeta,
    redaction_map: redactionMap,
    timestamp,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(uiElements && uiElements.length > 0 ? { ui_elements: uiElements } : {})
  };
}



/**
 * Dispatches the plan payload to the backend server.
 * @param {object} payload - Normalized plan payload
 * @param {string} [serverUrl=DEFAULT_SERVER_URL] - Target server plan endpoint
 * @param {object} [fetchOptions={}] - Additional fetch options (signal, custom headers)
 * @returns {Promise<{ actions: Array<object>, task_complete: boolean, confidence: number }>}
 */
export async function sendPayloadToServer(payload, serverUrl = DEFAULT_SERVER_URL, fetchOptions = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be a valid object');
  }

  const endpoint = serverUrl || DEFAULT_SERVER_URL;
  console.log(`[Transport] Posting payload to ${endpoint}...`);

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(fetchOptions.headers || {})
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: fetchOptions.signal
  });

  if (!response.ok) {
    let errBody = '';
    try {
      const errJson = await response.json();
      errBody = JSON.stringify(errJson);
    } catch {
      errBody = await response.text();
    }
    const msg = `[Transport] Failed to send payload (${response.status} ${response.statusText}): ${errBody}`;
    console.error(msg);
    throw new Error(msg);
  }

  const planResponse = await response.json();
  console.log('[Transport] Received plan response:', planResponse);

  if (Array.isArray(planResponse.actions)) {
    for (const action of planResponse.actions) {
      console.log(`[Transport] Received mock action: [${action.type}] selector="${action.target_selector}" reason="${action.reason}" bbox=${JSON.stringify(action.target_bbox)}`);
    }
  }

  return planResponse;
}

/**
 * Checks server health.
 * @param {string} [healthUrl=DEFAULT_HEALTH_URL]
 * @returns {Promise<boolean>}
 */
export async function checkServerHealth(healthUrl = DEFAULT_HEALTH_URL) {
  try {
    const res = await fetch(healthUrl, { method: 'GET' });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === 'ok';
  } catch (err) {
    console.warn('[Transport] Server health check failed:', err.message);
    return false;
  }
}
