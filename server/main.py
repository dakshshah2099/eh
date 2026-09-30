import base64
from collections import OrderedDict
import logging
import os
from pathlib import Path
import secrets
import time
from typing import Any, Optional
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)

from vlm_planner import (
    ActionItem,
    PlannerMeta,
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


def is_debug_save_enabled() -> bool:
    if DEBUG_SAVE_REDACTED:
        return True
    return os.getenv("DEBUG_SAVE_REDACTED", "0").strip().lower() in ("1", "true", "yes")


def save_debug_image(image_base64: str, task: str = "", step: int = 1) -> Path | None:
    if not is_debug_save_enabled() or not image_base64:
        return None
    try:
        REDACTED_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        _, encoded = image_base64.split(",", 1) if "," in image_base64 else ("", image_base64)
        data = base64.b64decode(encoded)
        ext = "png" if "image/png" in image_base64 else "jpg"
        unix_ms = int(time.time() * 1000)
        nonce = secrets.token_hex(3)
        filepath = REDACTED_IMAGES_DIR / f"debug_{unix_ms}_{nonce}.{ext}"
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
    category: Optional[str] = None
    type: Optional[str] = None
    source: Optional[str] = "dom"
    confidence: Optional[float] = 1.0

    model_config = {"extra": "allow"}

    @model_validator(mode="after")
    def populate_type_category(self) -> "RedactionMapItem":
        val = self.type or self.category or "redacted"
        if not self.type:
            self.type = val
        if not self.category:
            self.category = val
        return self

    @property
    def region_type(self) -> str:
        return self.type or self.category or "redacted"


class PlanRequest(BaseModel):
    task: str
    dom_skeleton: list[Any] | dict[str, Any]
    image_base64: str
    viewport: dict[str, Any]
    redaction_map: list[RedactionMapItem] = Field(default_factory=list)
    redacted_regions: Optional[list[RedactionMapItem]] = None
    coordinate_space: Optional[str] = "viewport"
    image: Optional[dict[str, Any]] = None
    ui_elements: Optional[list[Any]] = None
    session_id: Optional[str] = None
    task_id: Optional[str] = None
    timestamp: Optional[float] = None
    nonce: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = Field(
        default=None,
        deprecated=True,
        description="Deprecated: Upstream VLM provider credentials must be configured server-side via VLM_API_KEY. Client-supplied provider keys are ignored when server env key is set.",
    )

    @model_validator(mode="after")
    def sync_redacted_regions(self) -> "PlanRequest":
        if self.redacted_regions and not self.redaction_map:
            self.redaction_map = self.redacted_regions
        elif self.redaction_map and not self.redacted_regions:
            self.redacted_regions = self.redaction_map
        return self



@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


DEFAULT_STEP_HISTORY_TTL_SECONDS: float = 1800.0  # 30 minutes
DEFAULT_STEP_HISTORY_MAX_KEYS: int = 10000


def get_step_history_ttl() -> float:
    raw = os.getenv("STEP_HISTORY_TTL_SECONDS", str(DEFAULT_STEP_HISTORY_TTL_SECONDS))
    try:
        val = float(raw)
        return val if val >= 0 else DEFAULT_STEP_HISTORY_TTL_SECONDS
    except (ValueError, TypeError):
        return DEFAULT_STEP_HISTORY_TTL_SECONDS


def get_step_history_max_keys() -> int:
    raw = os.getenv("STEP_HISTORY_MAX_KEYS", str(DEFAULT_STEP_HISTORY_MAX_KEYS))
    try:
        val = int(raw)
        return val if val > 0 else DEFAULT_STEP_HISTORY_MAX_KEYS
    except (ValueError, TypeError):
        return DEFAULT_STEP_HISTORY_MAX_KEYS


class StepEntry(int):
    """Represents a step-history record storing step count and last_updated timestamp."""

    step: int
    last_updated: float

    def __new__(cls, step: int, last_updated: Optional[float] = None) -> "StepEntry":
        int_val = int(step)
        obj = super().__new__(cls, int_val)
        obj.step = int_val
        obj.last_updated = float(last_updated if last_updated is not None else time.time())
        return obj

    def __getitem__(self, item: str) -> Any:
        if item == "step":
            return self.step
        elif item == "last_updated":
            return self.last_updated
        raise KeyError(item)

    def get(self, item: str, default: Any = None) -> Any:
        if item == "step":
            return self.step
        elif item == "last_updated":
            return self.last_updated
        return default

    def to_dict(self) -> dict[str, Any]:
        return {"step": self.step, "last_updated": self.last_updated}

    def __repr__(self) -> str:
        return f"StepEntry(step={self.step}, last_updated={self.last_updated})"

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, StepEntry):
            return self.step == other.step and self.last_updated == other.last_updated
        if isinstance(other, (int, float)):
            return self.step == other
        return False


class StepHistoryStore(OrderedDict):
    """In-memory step-history store with TTL-based lazy eviction and bounded capacity."""

    def __init__(
        self,
        ttl: Optional[float] = None,
        max_keys: Optional[int] = None,
        *args: Any,
        **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        self._ttl = ttl
        self._max_keys = max_keys
        self._max_last_updated = 0.0

    @property
    def ttl(self) -> float:
        if self._ttl is not None:
            return self._ttl
        return get_step_history_ttl()

    @property
    def max_keys(self) -> int:
        if self._max_keys is not None:
            return self._max_keys
        return get_step_history_max_keys()

    def _ensure_sorted(self) -> None:
        """Keep entries in strictly ascending order of last_updated."""
        sorted_items = sorted(super().items(), key=lambda kv: kv[1].last_updated)
        super().clear()
        for k, v in sorted_items:
            super().__setitem__(k, v)
        if self:
            self._max_last_updated = super().__getitem__(next(reversed(self))).last_updated
        else:
            self._max_last_updated = 0.0

    def _is_expired(self, entry: StepEntry, now: Optional[float] = None) -> bool:
        if now is None:
            now = time.time()
        ttl = self.ttl
        if ttl is None or ttl < 0:
            return False
        return (now - entry.last_updated) > ttl

    def evict_expired(self, now: Optional[float] = None) -> int:
        """Evict all entries older than TTL. Returns number of evicted entries."""
        if now is None:
            now = time.time()
        ttl = self.ttl
        if ttl is None or ttl < 0:
            return 0
        cutoff = now - ttl
        evicted = 0

        while self:
            first_key = next(super().__iter__())
            first_entry = super().__getitem__(first_key)
            if first_entry.last_updated <= cutoff:
                super().__delitem__(first_key)
                evicted += 1
            else:
                break

        if len(self) == 0:
            self._max_last_updated = 0.0

        return evicted

    def sweep(self, now: Optional[float] = None) -> int:
        """Periodic sweep cleanup alias for evict_expired."""
        return self.evict_expired(now=now)

    def __getitem__(self, key: str) -> StepEntry:
        entry = super().__getitem__(key)
        if self._is_expired(entry):
            super().__delitem__(key)
            raise KeyError(key)
        return entry

    def __contains__(self, key: object) -> bool:
        if not super().__contains__(key):
            return False
        entry = super().__getitem__(key)
        if self._is_expired(entry):
            super().__delitem__(key)
            return False
        return True

    def get(self, key: str, default: Any = None) -> Any:
        if not super().__contains__(key):
            return default
        entry = super().__getitem__(key)
        if self._is_expired(entry):
            super().__delitem__(key)
            return default
        return entry

    def get_step(self, key: str, default: int = 0) -> int:
        """Get current step count for key, returning default if missing or expired."""
        entry = self.get(key)
        if entry is None:
            return default
        return entry.step if hasattr(entry, "step") else int(entry)

    def record_step(self, key: str, step: Optional[int] = None, timestamp: Optional[float] = None) -> int:
        """Record or increment step for key with timestamp, returning updated step."""
        if step is None:
            step = self.get_step(key, 0) + 1
        now = timestamp if timestamp is not None else time.time()
        self[key] = StepEntry(step=step, last_updated=now)
        return step

    def __setitem__(self, key: str, value: Any) -> None:
        now = time.time()
        # 1. Lazily evict expired entries on every write before inserting
        self.evict_expired(now=now)

        # 2. Normalize value to StepEntry
        if isinstance(value, StepEntry):
            entry = value
        elif isinstance(value, int):
            entry = StepEntry(step=value, last_updated=now)
        elif isinstance(value, dict):
            entry = StepEntry(
                step=int(value.get("step", 0)),
                last_updated=float(value.get("last_updated", now)),
            )
        elif isinstance(value, tuple) and len(value) == 2:
            entry = StepEntry(step=int(value[0]), last_updated=float(value[1]))
        else:
            step_val = getattr(value, "step", int(value))
            last_updated_val = getattr(value, "last_updated", now)
            entry = StepEntry(step=int(step_val), last_updated=float(last_updated_val))

        # Check chronology and insert
        if len(self) == 0:
            self._max_last_updated = entry.last_updated
            super().__setitem__(key, entry)
        elif entry.last_updated < self._max_last_updated:
            super().__setitem__(key, entry)
            self._ensure_sorted()
        else:
            self._max_last_updated = entry.last_updated
            super().__setitem__(key, entry)
            self.move_to_end(key)

        # 3. Cap total store size: evict oldest entry if cap is exceeded
        max_k = self.max_keys
        if max_k > 0:
            while len(self) > max_k:
                super().__delitem__(next(super().__iter__()))

    def clear(self) -> None:
        super().clear()
        self._max_last_updated = 0.0


_step_history: StepHistoryStore = StepHistoryStore()
NONCE_TTL_SECONDS: float = 60.0
_nonce_cache: dict[str, float] = {}


def evict_expired_nonces(current_time: Optional[float] = None) -> None:
    """Evicts nonce entries older than NONCE_TTL_SECONDS (60s lazy eviction)."""
    now = current_time if current_time is not None else time.time()
    expired = [k for k, t in _nonce_cache.items() if now - t > NONCE_TTL_SECONDS]
    for k in expired:
        del _nonce_cache[k]


def check_and_record_nonce(nonce: Optional[str], current_time: Optional[float] = None) -> None:
    """Validates that a nonce has not been seen within the TTL window, and records it.
    Rejects duplicate nonces with HTTP 400."""
    if not nonce or not str(nonce).strip():
        return
    clean_nonce = str(nonce).strip()
    now = current_time if current_time is not None else time.time()
    evict_expired_nonces(now)
    if clean_nonce in _nonce_cache:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Replay detected: duplicate nonce '{clean_nonce}' within replay window",
        )
    _nonce_cache[clean_nonce] = now


@app.post("/api/plan")
def plan(
    payload: PlanRequest,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
    x_nonce: Optional[str] = Header(None, alias="X-Nonce"),
) -> PlanResponse:
    # 1. Verify authentication
    verify_auth_token(auth_header=authorization, api_key_header=x_api_key)

    # 2. Replay & timestamp freshness protection (>60s rejection)
    now = time.time()
    if payload.timestamp is not None:
        age = abs(now - payload.timestamp)
        if age > 60.0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Replay detected or request timestamp expired (age: {age:.1f}s > 60.0s)",
            )

    # 3. Nonce-based replay protection
    effective_nonce = payload.nonce or x_nonce
    if effective_nonce:
        check_and_record_nonce(effective_nonce, current_time=now)
    else:
        evict_expired_nonces(now)

    session_key = payload.session_id or "default_session"
    task_key = payload.task_id or payload.task or "default_task"
    composite_key = f"{session_key}:{task_key}"

    current_step = _step_history.get(composite_key, 0) + 1
    _step_history[composite_key] = current_step

    saved_file = save_debug_image(payload.image_base64, task_key, current_step)
    if saved_file:
        print(f"[Debug] Saved redacted screenshot to {saved_file.resolve()}")

    # 4. Provider credential security & deprecation check (C16)
    server_vlm_key = os.getenv("VLM_API_KEY") or os.getenv("OPENAI_API_KEY", "")
    effective_api_key = payload.api_key
    if payload.api_key:
        if server_vlm_key:
            logger.warning(
                "Client supplied deprecated PlanRequest.api_key, but server-side "
                "VLM_API_KEY is configured. Client key is ignored in favor of server env key."
            )
            effective_api_key = None
        else:
            logger.warning(
                "PlanRequest.api_key is deprecated: configure VLM_API_KEY in server environment instead."
            )

    try:
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
            api_key=effective_api_key,
            redacted_regions=payload.redacted_regions,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"VLM planning failed: {e}",
        ) from e



