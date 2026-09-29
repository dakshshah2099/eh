import time
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_cors_origin_policy():
    # 1. Allowed origin (localhost)
    resp = client.options(
        "/api/plan",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
        }
    )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000"

    # 2. Allowed Chrome Extension origin (standard 32 char ID)
    resp_ext = client.options(
        "/api/plan",
        headers={
            "Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "Access-Control-Request-Method": "POST",
        }
    )
    assert resp_ext.status_code == 200
    assert resp_ext.headers.get("access-control-allow-origin") == "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

    # 3. Disallowed untrusted origin (e.g. malicious site)
    resp_evil = client.options(
        "/api/plan",
        headers={
            "Origin": "https://malicious-attacker.com",
            "Access-Control-Request-Method": "POST",
        }
    )
    assert resp_evil.headers.get("access-control-allow-origin") is None


def test_auth_token_required_when_configured():
    valid_payload = {
        "task": "Test secure task",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
    }

    with patch("main.REQUIRE_AUTH", True), patch("main.SERVER_API_KEY", "secret-test-key"):
        # 1. Missing auth credentials -> 401
        res_no_auth = client.post("/api/plan", json=valid_payload)
        assert res_no_auth.status_code == 401
        assert "Invalid or missing authentication" in res_no_auth.json()["detail"]

        # 2. Invalid Bearer token -> 401
        res_bad_token = client.post(
            "/api/plan",
            json=valid_payload,
            headers={"Authorization": "Bearer wrong-key"}
        )
        assert res_bad_token.status_code == 401

        # 3. Valid Bearer token -> 200
        with patch("main.generate_plan") as mock_gen:
            from vlm_planner import PlanResponse, ActionItem
            mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)
            res_good_token = client.post(
                "/api/plan",
                json=valid_payload,
                headers={"Authorization": "Bearer secret-test-key"}
            )
            assert res_good_token.status_code == 200

        # 4. Valid X-API-Key header -> 200
        with patch("main.generate_plan") as mock_gen:
            mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)
            res_api_key = client.post(
                "/api/plan",
                json=valid_payload,
                headers={"X-API-Key": "secret-test-key"}
            )
            assert res_api_key.status_code == 200


def test_request_timestamp_replay_check():
    now = time.time()
    stale_payload = {
        "task": "Test stale timestamp replay",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
        "timestamp": now - 120.0, # 2 minutes old (>60s)
    }

    fresh_payload = {
        "task": "Test fresh timestamp",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
        "timestamp": now - 5.0, # 5s old (<60s)
    }

    # Stale request rejected
    res_stale = client.post("/api/plan", json=stale_payload)
    assert res_stale.status_code == 400
    assert "Replay detected or request timestamp expired" in res_stale.json()["detail"]

    # Fresh request accepted
    with patch("main.generate_plan") as mock_gen:
        from vlm_planner import PlanResponse, ActionItem
        mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)
        res_fresh = client.post("/api/plan", json=fresh_payload)
        assert res_fresh.status_code == 200
