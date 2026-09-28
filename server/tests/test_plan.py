from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_plan_valid_payload():
    payload = {
        "task": "Click submit button",
        "dom_skeleton": [
            {"tag": "button", "id": "submit", "text": "Submit"}
        ],
        "image_base64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "viewport": {"width": 1280, "height": 720, "devicePixelRatio": 1.0},
        "redaction_map": [
            {
                "bbox": [10.0, 10.0, 50.0, 20.0],
                "category": "PII",
                "source": "dom",
                "confidence": 0.99,
            }
        ],
    }
    response = client.post("/api/plan", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data == {
        "actions": [
            {
                "type": "click",
                "target_bbox": [10.0, 10.0, 50.0, 20.0],
                "target_selector": "button#submit",
                "reason": "test",
            }
        ],
        "task_complete": False,
        "confidence": 0.95,
    }


def test_plan_valid_dict_dom_skeleton():
    payload = {
        "task": "Test task",
        "dom_skeleton": {"root": {"tag": "body"}},
        "image_base64": "abc123==",
        "viewport": {"width": 800, "height": 600},
        "redaction_map": [],
    }
    response = client.post("/api/plan", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["task_complete"] is False
    assert len(data["actions"]) == 1


def test_plan_invalid_schema():
    # Missing required field 'task'
    payload = {
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {},
        "redaction_map": [],
    }
    response = client.post("/api/plan", json=payload)
    assert response.status_code == 422

    # Invalid redaction_map item
    invalid_redaction = {
        "task": "Test",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {},
        "redaction_map": [
            {
                "bbox": "invalid_bbox",
                "category": "PII",
                "source": "dom",
                "confidence": 0.9,
            }
        ],
    }
    response = client.post("/api/plan", json=invalid_redaction)
    assert response.status_code == 422
