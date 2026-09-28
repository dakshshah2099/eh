from typing import Any
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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


@app.post("/api/plan")
def plan(payload: PlanRequest) -> PlanResponse:
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
