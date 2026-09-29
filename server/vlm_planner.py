import json
import logging
import os
import re
from typing import Any, Dict, List, Optional
import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

OPENAI_COMPATIBLE_PROVIDERS = {
    "openai",
    "openai-compatible",
    "openai_compatible",
    "litellm",
    "vllm",
    "qwen",
    "gpt-4o",
}

def get_vlm_provider() -> str:
    return os.getenv("VLM_PROVIDER", "ollama").lower()

def get_vlm_model() -> str:
    return os.getenv("VLM_MODEL", "llama3.2-vision")

def get_vlm_base_url() -> Optional[str]:
    return os.getenv("VLM_BASE_URL")

def get_vlm_api_key() -> str:
    return os.getenv("VLM_API_KEY") or os.getenv("OPENAI_API_KEY", "")

def get_ollama_base_url() -> str:
    return os.getenv("VLM_BASE_URL") or os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

def get_openai_base_url() -> str:
    return os.getenv("VLM_BASE_URL") or os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")

def get_openai_api_key() -> str:
    return get_vlm_api_key()

def get_vlm_timeout() -> float:
    return float(os.getenv("VLM_TIMEOUT_SECONDS", "30.0"))


class ActionItem(BaseModel):
    type: str
    target_bbox: Optional[List[float]] = None
    target_selector: Optional[str] = None
    target_element_id: Optional[str] = None
    secret_key: Optional[str] = None
    text: Optional[str] = None
    url: Optional[str] = None
    reason: Optional[str] = None



class PlanResponse(BaseModel):
    actions: List[ActionItem] = Field(default_factory=list)
    task_complete: bool = False
    confidence: float = 1.0


SYSTEM_PROMPT = """You are a web automation vision-language planner.
Your goal is to accomplish the user task given the current browser state.

Input state includes:
- User task description
- Redacted / Sanitized viewport screenshot
- DOM skeleton representing elements on page
- Detected UI elements with bounding boxes and optional element IDs
- Redaction metadata (PII/sensitive areas)

Available action types:
- "click": requires target_selector or target_bbox or target_element_id
- "type": requires text and (target_selector or target_bbox or target_element_id)
- "fill_secret": requires secret_key alias (e.g. ACCOUNT_PASSWORD) and target locator; never output raw passwords!
- "scroll": direction/delta or target element
- "wait": wait for navigation/render
- "navigate": requires url

Output MUST be a single valid JSON object strictly matching this schema:
{
  "actions": [
    {
      "type": "click" | "type" | "fill_secret" | "scroll" | "wait" | "navigate",
      "target_selector": "string or null",
      "target_bbox": [x, y, w, h] or null,
      "target_element_id": "string or null",
      "secret_key": "string or null",
      "text": "text to type if type action, else null",
      "reason": "short explanation"
    }
  ],
  "task_complete": boolean,
  "confidence": number between 0.0 and 1.0
}


If the task has been fully completed by the observed state, set "task_complete": true and "actions": [].
Do NOT wrap your JSON in markdown fences. Output raw JSON only."""


def build_planner_prompt(
    task: str,
    dom_skeleton: Any,
    ui_elements: Optional[List[Any]],
    redaction_map: List[Any],
    viewport: Dict[str, Any],
) -> str:
    parts = [f"TASK: {task}\n"]
    parts.append(f"VIEWPORT: {json.dumps(viewport)}\n")

    if ui_elements:
        parts.append(f"DETECTED UI ELEMENTS:\n{json.dumps(ui_elements, indent=2)}\n")

    if redaction_map:
        redaction_summary = [
            {
                "bbox": item.get("bbox") if isinstance(item, dict) else getattr(item, "bbox", None),
                "category": item.get("category") if isinstance(item, dict) else getattr(item, "category", None),
                "source": item.get("source") if isinstance(item, dict) else getattr(item, "source", None),
            }
            for item in redaction_map
        ]
        parts.append(f"REDACTED REGIONS (do not leak/target PII):\n{json.dumps(redaction_summary, indent=2)}\n")

    if dom_skeleton:
        parts.append(f"DOM SKELETON:\n{json.dumps(dom_skeleton, indent=2)}\n")

    parts.append("Decide the next action(s) to progress towards completing the task. Return JSON only.")
    return "\n".join(parts)


def normalize_action_dict(item: Dict[str, Any]) -> Dict[str, Any]:
    norm = dict(item)
    if "type" not in norm and "action" in norm:
        norm["type"] = norm["action"]
    if "target_selector" not in norm and "selector" in norm:
        norm["target_selector"] = norm["selector"]
    if "target_bbox" not in norm and "bbox" in norm:
        norm["target_bbox"] = norm["bbox"]
    if "target_element_id" not in norm and "element_id" in norm:
        norm["target_element_id"] = norm["element_id"]
    if "secret_key" not in norm and "secret_alias" in norm:
        norm["secret_key"] = norm["secret_alias"]
    elif "secret_key" not in norm and "secretKey" in norm:
        norm["secret_key"] = norm["secretKey"]
    return norm



def parse_vlm_response(raw_text: str) -> PlanResponse:
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned).strip()

    try:
        data = json.loads(cleaned)
    except Exception:
        # Try extracting code block JSON first
        code_block = re.search(r"```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```", cleaned)
        if code_block:
            data = json.loads(code_block.group(1))
        else:
            match = re.search(r"(\{[\s\S]*\})", cleaned)
            if match:
                data = json.loads(match.group(1))
            else:
                list_match = re.search(r"(\[[\s\S]*\])", cleaned)
                if list_match:
                    data = json.loads(list_match.group(1))
                else:
                    raise ValueError(f"Could not parse valid JSON from VLM output: {raw_text[:200]}")

    if isinstance(data, list):
        data = {"actions": data, "task_complete": False, "confidence": 0.9}

    if isinstance(data, dict):
        actions = data.get("actions")
        if isinstance(actions, list):
            data["actions"] = [
                normalize_action_dict(a) if isinstance(a, dict) else a
                for a in actions
            ]

    return PlanResponse.model_validate(data)


def call_ollama(
    prompt: str,
    image_base64: str,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    timeout: Optional[float] = None,
) -> str:
    active_base_url = base_url or get_ollama_base_url()
    active_model = model or get_vlm_model()
    active_timeout = timeout if timeout is not None else get_vlm_timeout()

    clean_b64 = image_base64
    if "," in clean_b64:
        clean_b64 = clean_b64.split(",", 1)[1]

    payload: Dict[str, Any] = {
        "model": active_model,
        "prompt": f"{SYSTEM_PROMPT}\n\n{prompt}",
        "stream": False,
        "format": "json",
    }
    if clean_b64.strip():
        payload["images"] = [clean_b64.strip()]

    url = active_base_url if active_base_url.endswith("/api/generate") else f"{active_base_url.rstrip('/')}/api/generate"
    with httpx.Client(timeout=active_timeout) as client:
        resp = client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data.get("response", "")


def call_openai_compatible(
    prompt: str,
    image_base64: str,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout: Optional[float] = None,
) -> str:
    active_base_url = base_url or get_openai_base_url()
    active_model = model or get_vlm_model()
    active_api_key = api_key if api_key is not None else get_openai_api_key()
    active_timeout = timeout if timeout is not None else get_vlm_timeout()

    clean_b64 = image_base64
    mime_type = "image/png"
    if "," in clean_b64:
        header, encoded = clean_b64.split(",", 1)
        clean_b64 = encoded
        if "image/jpeg" in header or "image/jpg" in header:
            mime_type = "image/jpeg"
        elif "image/webp" in header:
            mime_type = "image/webp"

    user_content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    if clean_b64.strip():
        user_content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime_type};base64,{clean_b64.strip()}"}
        })

    payload = {
        "model": active_model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "response_format": {"type": "json_object"},
    }

    headers = {"Content-Type": "application/json"}
    if active_api_key:
        headers["Authorization"] = f"Bearer {active_api_key}"

    url = active_base_url if active_base_url.endswith("/chat/completions") else f"{active_base_url.rstrip('/')}/chat/completions"
    with httpx.Client(timeout=active_timeout) as client:
        resp = client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


def fallback_plan(task: str, dom_skeleton: Any, ui_elements: Optional[List[Any]]) -> PlanResponse:
    """Heuristic fallback planner if VLM service is unreachable or offline."""
    task_lower = task.lower()

    # Look for button or clickable target
    if ui_elements:
        for elem in ui_elements:
            elem_label = (elem.get("label") or elem.get("text") or "").lower()
            if any(word in elem_label for word in task_lower.split()):
                return PlanResponse(
                    actions=[
                        ActionItem(
                            type="click",
                            target_bbox=elem.get("bbox"),
                            target_element_id=elem.get("element_id") or elem.get("id"),
                            reason=f"Matched UI element {elem_label}",
                        )
                    ],
                    task_complete=False,
                    confidence=0.7,
                )

    if isinstance(dom_skeleton, list):
        for node in dom_skeleton:
            if isinstance(node, dict):
                text = str(node.get("text", "")).lower()
                tag = str(node.get("tag", "")).lower()
                elem_id = node.get("id")
                if "submit" in task_lower and ("submit" in text or "submit" in str(elem_id).lower() or tag == "button"):
                    return PlanResponse(
                        actions=[
                            ActionItem(
                                type="click",
                                target_selector=f"#{elem_id}" if elem_id else "button[type='submit'], button",
                                reason="Heuristic match for submit button",
                            )
                        ],
                        task_complete=False,
                        confidence=0.6,
                    )

    return PlanResponse(
        actions=[
            ActionItem(
                type="wait",
                reason="Default fallback action while waiting for state change",
            )
        ],
        task_complete=False,
        confidence=0.5,
    )


def generate_plan(
    task: str,
    dom_skeleton: Any,
    image_base64: str,
    viewport: Dict[str, Any],
    redaction_map: List[Any],
    ui_elements: Optional[List[Any]] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> PlanResponse:
    active_provider = (provider or get_vlm_provider()).lower()
    active_model = model or get_vlm_model()

    prompt = build_planner_prompt(
        task=task,
        dom_skeleton=dom_skeleton,
        ui_elements=ui_elements,
        redaction_map=redaction_map,
        viewport=viewport,
    )

    try:
        if active_provider in OPENAI_COMPATIBLE_PROVIDERS or active_provider.startswith("openai"):
            raw_response = call_openai_compatible(
                prompt=prompt,
                image_base64=image_base64,
                base_url=base_url or get_openai_base_url(),
                model=active_model,
                api_key=api_key or get_openai_api_key(),
            )
        elif active_provider in ("ollama", "llava", "llama3.2-vision") or active_provider.startswith("ollama"):
            raw_response = call_ollama(
                prompt=prompt,
                image_base64=image_base64,
                base_url=base_url or get_ollama_base_url(),
                model=active_model,
            )
        elif active_provider in ("fallback", "mock"):
            return fallback_plan(task=task, dom_skeleton=dom_skeleton, ui_elements=ui_elements)
        else:
            raise ValueError(f"Unsupported VLM provider: {active_provider}")

        return parse_vlm_response(raw_response)
    except Exception as e:
        logger.warning(f"VLM planning request failed ({e}), using fallback planner.")
        return fallback_plan(task=task, dom_skeleton=dom_skeleton, ui_elements=ui_elements)
