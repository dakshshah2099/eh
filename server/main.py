import base64
import os
from pathlib import Path
from typing import Any, Optional
from dotenv import load_dotenv
import time
from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from vlm_planner import (
    ActionItem,
    PlanResponse,
    generate_plan,
)

# Load environment variables from .env file (if present)
load_dotenv(Path(__file__).parent / ".env")
load_dotenv()

DEBUG_SAVE_REDACTED = os.getenv("DEBUG_SAVE_REDACTED", "0").lower() in ("1", "true", "yes")
REDACTED_IMAGES_DIR = Path(os.getenv("REDACTED_IMAGES_DIR", "debug_redacted_images"))
SERVER_API_KEY = os.getenv("SERVER_API_KEY", "")
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "0").lower() in ("1", "true", "yes") or bool(SERVER_API_KEY)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost,http://127.0.0.1,chrome-extension://*",
    ).split(",")
    if origin.strip()
]


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

# Restrict CORS to configured extension ID / localhost origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"^(chrome-extension:\/\/[a-z]{32}|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def verify_auth_token(auth_header: Optional[str] = Header(None, alias="Authorization"), api_key_header: Optional[str] = Header(None, alias="X-API-Key")) -> None:
    """Verifies API key or Bearer token if auth is enabled."""
    if not REQUIRE_AUTH and not SERVER_API_KEY:
        return
    token = None
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ", 1)[1].strip()
    elif api_key_header:
        token = api_key_header.strip()

    if not token or token != SERVER_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
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
    coordinate_space: Optional[str] = "viewport"
    image: Optional[dict[str, Any]] = None
    ui_elements: Optional[list[Any]] = None
    session_id: Optional[str] = None
    task_id: Optional[str] = None
    timestamp: Optional[float] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None



@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


_step_history: dict[str, int] = {}


@app.post("/api/plan")
def plan(
    payload: PlanRequest,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> PlanResponse:
    # 1. Verify authentication
    verify_auth_token(auth_header=authorization, api_key_header=x_api_key)

    # 2. Replay & timestamp freshness protection (>60s rejection)
    if payload.timestamp is not None:
        now = time.time()
        age = abs(now - payload.timestamp)
        if age > 60.0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Replay detected or request timestamp expired (age: {age:.1f}s > 60.0s)",
            )

    session_key = payload.session_id or "default_session"
    task_key = payload.task_id or payload.task or "default_task"
    composite_key = f"{session_key}:{task_key}"

    current_step = _step_history.get(composite_key, 0) + 1
    _step_history[composite_key] = current_step

    saved_file = save_debug_image(payload.image_base64, task_key, current_step)
    if saved_file:
        print(f"[Debug] Saved redacted screenshot to {saved_file.resolve()}")

    return generate_plan(
        task=payload.task,
        dom_skeleton=payload.dom_skeleton,
        image_base64=payload.image_base64,
        viewport=payload.viewport,
        redaction_map=payload.redaction_map,
        ui_elements=payload.ui_elements,
        provider=payload.provider,
        model=payload.model,
        base_url=payload.base_url,
        api_key=payload.api_key,
    )



