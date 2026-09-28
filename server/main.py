import base64
import os
from pathlib import Path
from typing import Any
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DEBUG_SAVE_REDACTED = os.getenv("DEBUG_SAVE_REDACTED", "0").lower() in ("1", "true", "yes")
REDACTED_IMAGES_DIR = Path(os.getenv("REDACTED_IMAGES_DIR", "debug_redacted_images"))


def save_debug_image(image_base64: str, task: str, step: int) -> Path | None:
    if not DEBUG_SAVE_REDACTED or not image_base64:
        return None
    try:
        REDACTED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        _, encoded = image_base64.split(",", 1) if "," in image_base64 else ("", image_base64)
        data = base64.b64decode(encoded)
        ext = "png" if "image/png" in image_base64 else "jpg"
        clean_task = "".join(c if c.isalnum() else "_" for c in task[:20]).strip("_") or "task"
        filepath = REDACTED_IMAGES_DIR / f"{clean_task}_step_{step}.{ext}"
        filepath.write_bytes(data)
        return filepath
    except Exception as e:
        print(f"[Debug] Failed to save redacted image: {e}")
        return None

app = FastAPI(title="On-Device Visual Perception Server")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RedactionMapItem(BaseModel):
    bbox: list[float]
    category: str
    source: str
    confidence: float


class PlanRequest(BaseModel):
    task: str
    dom_skeleton: list[Any] | dict[str, Any]
    image_base64: str
    viewport: dict[str, Any]
    redaction_map: list[RedactionMapItem]


class ActionItem(BaseModel):
    type: str
    target_bbox: list[float] | None = None
    target_selector: str | None = None
    reason: str | None = None


class PlanResponse(BaseModel):
    actions: list[ActionItem]
    task_complete: bool = False
    confidence: float


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


_step_history: dict[str, int] = {}


@app.post("/api/plan")
def plan(payload: PlanRequest) -> PlanResponse:
    task_key = payload.task or "default"
    current_step = _step_history.get(task_key, 0) + 1
    _step_history[task_key] = current_step

    saved_file = save_debug_image(payload.image_base64, task_key, current_step)
    if saved_file:
        print(f"[Debug] Saved redacted screenshot to {saved_file.resolve()}")

    if current_step == 1:
        return PlanResponse(
            actions=[
                ActionItem(
                    type="click",
                    target_bbox=[10.0, 10.0, 50.0, 20.0],
                    target_selector="button#submit",
                    reason="test",
                )
            ],
            task_complete=False,
            confidence=0.95,
        )

    _step_history[task_key] = 0
    return PlanResponse(
        actions=[],
        task_complete=True,
        confidence=0.99,
    )
