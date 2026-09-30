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


def test_debug_save_redacted_default_disabled(monkeypatch, tmp_path):
    import main

    test_dir = tmp_path / "debug_images"
    monkeypatch.setattr(main, "REDACTED_IMAGES_DIR", test_dir)

    b64_img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    sensitive_task = "Transfer $5000 secret funds"

    # 1. With DEBUG_SAVE_REDACTED unset
    monkeypatch.delenv("DEBUG_SAVE_REDACTED", raising=False)
    monkeypatch.setattr(main, "DEBUG_SAVE_REDACTED", False)
    saved = main.save_debug_image(b64_img, task=sensitive_task, step=1)
    assert saved is None
    assert not test_dir.exists() or len(list(test_dir.iterdir())) == 0

    # 2. With DEBUG_SAVE_REDACTED="0"
    monkeypatch.setenv("DEBUG_SAVE_REDACTED", "0")
    monkeypatch.setattr(main, "DEBUG_SAVE_REDACTED", False)
    saved_zero = main.save_debug_image(b64_img, task=sensitive_task, step=1)
    assert saved_zero is None
    assert not test_dir.exists() or len(list(test_dir.iterdir())) == 0

    # 3. With DEBUG_SAVE_REDACTED="false"
    monkeypatch.setenv("DEBUG_SAVE_REDACTED", "false")
    monkeypatch.setattr(main, "DEBUG_SAVE_REDACTED", False)
    saved_false = main.save_debug_image(b64_img, task=sensitive_task, step=1)
    assert saved_false is None
    assert not test_dir.exists() or len(list(test_dir.iterdir())) == 0


def test_debug_save_redacted_enabled_no_task_text(monkeypatch, tmp_path):
    import re
    import main

    test_dir = tmp_path / "debug_images"
    monkeypatch.setattr(main, "REDACTED_IMAGES_DIR", test_dir)
    monkeypatch.setenv("DEBUG_SAVE_REDACTED", "1")
    monkeypatch.setattr(main, "DEBUG_SAVE_REDACTED", False)

    png_b64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    task_text = "Purchase sensitive medication order 99238"

    saved_png = main.save_debug_image(png_b64, task=task_text, step=3)
    assert saved_png is not None
    assert saved_png.exists()

    # Filename format: debug_<unix_ms>_<6hex>.png
    pattern = r"^debug_\d+_[0-9a-fA-F]{6}\.png$"
    assert re.match(pattern, saved_png.name), f"Filename '{saved_png.name}' did not match pattern '{pattern}'"

    # Verify NO part of the task string is embedded in the filename
    name_lower = saved_png.name.lower()
    assert task_text.lower() not in name_lower
    for word in ["purchase", "sensitive", "medication", "order", "99238"]:
        assert word not in name_lower, f"Task word '{word}' found in filename '{saved_png.name}'"

    # Verify JPEG extension handling without task text
    jpg_b64 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
    saved_jpg = main.save_debug_image(jpg_b64, task=task_text, step=1)
    assert saved_jpg is not None
    assert saved_jpg.exists()
    jpg_pattern = r"^debug_\d+_[0-9a-fA-F]{6}\.jpg$"
    assert re.match(jpg_pattern, saved_jpg.name), f"Filename '{saved_jpg.name}' did not match pattern '{jpg_pattern}'"
    assert "medication" not in saved_jpg.name.lower()


def test_api_plan_endpoint_debug_image_behavior(monkeypatch, tmp_path):
    import re
    import main
    from vlm_planner import PlanResponse, ActionItem

    test_dir = tmp_path / "endpoint_debug_images"
    monkeypatch.setattr(main, "REDACTED_IMAGES_DIR", test_dir)

    payload = {
        "task": "Confidential banking password reset",
        "dom_skeleton": [],
        "image_base64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
    }

    # 1. Default (DEBUG_SAVE_REDACTED=0) -> no debug image saved
    monkeypatch.setenv("DEBUG_SAVE_REDACTED", "0")
    monkeypatch.setattr(main, "DEBUG_SAVE_REDACTED", False)
    with patch("main.generate_plan") as mock_gen:
        mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)
        resp = client.post("/api/plan", json=payload)
        assert resp.status_code == 200
        assert not test_dir.exists() or len(list(test_dir.iterdir())) == 0

    # 2. Enabled (DEBUG_SAVE_REDACTED=1) -> debug image saved with no task text
    monkeypatch.setenv("DEBUG_SAVE_REDACTED", "1")
    monkeypatch.setattr(main, "DEBUG_SAVE_REDACTED", False)
    with patch("main.generate_plan") as mock_gen:
        mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)
        resp = client.post("/api/plan", json=payload)
        assert resp.status_code == 200
        saved_files = list(test_dir.glob("debug_*"))
        assert len(saved_files) == 1
        saved_file = saved_files[0]
        assert re.match(r"^debug_\d+_[0-9a-fA-F]{6}\.png$", saved_file.name)
        assert "confidential" not in saved_file.name.lower()
        assert "password" not in saved_file.name.lower()
        assert "banking" not in saved_file.name.lower()



def test_nonce_replay_protection_duplicate_rejected():
    """A replayed identical request with the same nonce within the timestamp window must be rejected with HTTP 400."""
    import main
    from vlm_planner import PlanResponse, ActionItem

    now = time.time()
    nonce = f"test-nonce-{now}-unique"
    payload = {
        "task": "Test nonce replay protection",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
        "timestamp": now,
        "nonce": nonce,
    }

    with patch("main.generate_plan") as mock_gen:
        mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)

        # 1. First attempt with fresh nonce succeeds (HTTP 200)
        res1 = client.post("/api/plan", json=payload)
        assert res1.status_code == 200

        # 2. Second attempt (replay of identical request with same nonce) -> rejected with HTTP 400
        res2 = client.post("/api/plan", json=payload)
        assert res2.status_code == 400
        assert "Replay detected" in res2.json()["detail"]
        assert "duplicate nonce" in res2.json()["detail"]

        # 3. Third attempt with a fresh unique nonce -> succeeds (HTTP 200)
        fresh_payload = {**payload, "nonce": f"{nonce}-different"}
        res3 = client.post("/api/plan", json=fresh_payload)
        assert res3.status_code == 200


def test_nonce_replay_protection_header_x_nonce():
    """Replaying requests with identical X-Nonce header is also rejected with HTTP 400."""
    from vlm_planner import PlanResponse, ActionItem

    now = time.time()
    header_nonce = f"x-nonce-test-{now}"
    payload = {
        "task": "Test X-Nonce header replay protection",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
        "timestamp": now,
    }

    with patch("main.generate_plan") as mock_gen:
        mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)

        # 1. First request with header nonce -> 200
        res1 = client.post("/api/plan", json=payload, headers={"X-Nonce": header_nonce})
        assert res1.status_code == 200

        # 2. Duplicate request with same header nonce -> 400
        res2 = client.post("/api/plan", json=payload, headers={"X-Nonce": header_nonce})
        assert res2.status_code == 400
        assert "Replay detected" in res2.json()["detail"]


def test_nonce_cache_lazy_eviction_after_ttl():
    """Nonce entries older than TTL (60s) are evicted lazily and do not falsely reject fresh requests."""
    import main
    from vlm_planner import PlanResponse, ActionItem

    now = time.time()
    expired_nonce = f"expired-nonce-{now}"
    # Seed cache with an entry that arrived 65s ago (>60s TTL)
    main._nonce_cache[expired_nonce] = now - 65.0

    payload = {
        "task": "Test TTL eviction",
        "dom_skeleton": [],
        "image_base64": "abc",
        "viewport": {"width": 1000, "height": 800},
        "redaction_map": [],
        "timestamp": now,
        "nonce": expired_nonce,
    }

    with patch("main.generate_plan") as mock_gen:
        mock_gen.return_value = PlanResponse(actions=[ActionItem(type="wait")], task_complete=False)

        # Expired nonce was lazily evicted, request should be accepted
        res = client.post("/api/plan", json=payload)
        assert res.status_code == 200
        assert main._nonce_cache[expired_nonce] >= now

