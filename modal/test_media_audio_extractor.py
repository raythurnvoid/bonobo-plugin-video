import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from media_audio_extractor import (
    media_audio_extractor_cleanup_expired_entries,
    media_audio_extractor_create_app,
    media_audio_extractor_sign_entry,
)


class FakeHTTPError(Exception):
    pass


class FakeRequestException(Exception):
    pass


class FakeResponse:
    def __init__(self, chunks, http_error=False):
        self.chunks = chunks
        self.http_error = http_error

    def __enter__(self):
        return self

    def __exit__(self, _exception_type, _exception, _traceback):
        return False

    def raise_for_status(self):
        if self.http_error:
            raise FakeHTTPError("download failed")

    def iter_content(self, chunk_size):
        for chunk in self.chunks:
            yield chunk


class FakeRequests:
    HTTPError = FakeHTTPError
    RequestException = FakeRequestException

    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, source_url, stream, timeout):
        self.calls.append(
            {
                "source_url": source_url,
                "stream": stream,
                "timeout": timeout,
            }
        )
        return self.response


class FakeProber:
    def __init__(self, audio_codec="aac", duration_seconds=12.5):
        self.result = {"audioCodec": audio_codec, "durationSeconds": duration_seconds}
        self.calls = []

    def __call__(self, source_path):
        self.calls.append({"content": Path(source_path).read_bytes()})
        return self.result


class FakeExtractor:
    def __init__(self, audio_bytes=b"fake-audio"):
        self.audio_bytes = audio_bytes
        self.calls = []

    def __call__(self, source_path, target_path, audio_codec):
        self.calls.append(
            {
                "content": Path(source_path).read_bytes(),
                "audio_codec": audio_codec,
            }
        )
        Path(target_path).write_bytes(self.audio_bytes)


class FailingExtractor:
    def __call__(self, _source_path, _target_path, _audio_codec):
        raise RuntimeError("ffmpeg exited with status 1")


def test_health_returns_ok(tmp_path):
    client = TestClient(
        media_audio_extractor_create_app(
            requests_module=FakeRequests(FakeResponse([])),
            media_prober=FakeProber(),
            audio_extractor=FakeExtractor(),
            storage_dir=tmp_path,
        )
    )

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_sign_entry_round_trip_and_tamper():
    signature = media_audio_extractor_sign_entry("entry", 1_000, "secret")

    assert signature == media_audio_extractor_sign_entry("entry", 1_000, "secret")
    assert signature != media_audio_extractor_sign_entry("other", 1_000, "secret")
    assert signature != media_audio_extractor_sign_entry("entry", 1_001, "secret")
    assert signature != media_audio_extractor_sign_entry("entry", 1_000, "other-secret")


def test_extract_audio_stores_entry_and_serves_signed_url(monkeypatch, tmp_path):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    fake_requests = FakeRequests(FakeResponse([b"hello", b" ", b"world"]))
    prober = FakeProber(audio_codec="aac", duration_seconds=12.5)
    extractor = FakeExtractor(audio_bytes=b"fake-audio")
    client = TestClient(
        media_audio_extractor_create_app(
            requests_module=fake_requests,
            media_prober=prober,
            audio_extractor=extractor,
            storage_dir=tmp_path,
        )
    )

    before = int(time.time())
    response = client.post(
        "/extract-audio",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourceUrl": "https://r2.test/organizations/ws/workspaces/pr/nodes/node/source",
            "contentType": "video/mp4",
            "maxBytes": 100,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["bytes"] == len(b"fake-audio")
    assert payload["durationSeconds"] == 12.5
    assert before + 890 <= payload["expiresAt"] <= int(time.time()) + 900
    assert fake_requests.calls == [
        {
            "source_url": "https://r2.test/organizations/ws/workspaces/pr/nodes/node/source",
            "stream": True,
            "timeout": (10, 120),
        }
    ]
    assert prober.calls == [{"content": b"hello world"}]
    assert extractor.calls == [{"content": b"hello world", "audio_codec": "aac"}]

    audio_url = urlsplit(payload["audioUrl"])
    entry_id = audio_url.path.removeprefix("/audio/")
    query = parse_qs(audio_url.query)
    assert int(query["exp"][0]) == payload["expiresAt"]
    assert query["sig"][0] == media_audio_extractor_sign_entry(entry_id, payload["expiresAt"], "secret")
    assert (tmp_path / f"{entry_id}-{payload['expiresAt']}.m4a").read_bytes() == b"fake-audio"

    serve_response = client.get(payload["audioUrl"])

    assert serve_response.status_code == 200
    assert serve_response.content == b"fake-audio"
    assert serve_response.headers["content-type"] == "audio/mp4"


def test_unauthorized_request_does_not_download(monkeypatch, tmp_path):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    fake_requests = FakeRequests(FakeResponse([b"hello"]))
    extractor = FakeExtractor()
    client = TestClient(
        media_audio_extractor_create_app(
            requests_module=fake_requests,
            media_prober=FakeProber(),
            audio_extractor=extractor,
            storage_dir=tmp_path,
        )
    )

    response = client.post(
        "/extract-audio",
        json={
            "sourceUrl": "https://r2.test/source",
            "maxBytes": 100,
        },
    )

    assert response.status_code == 401
    assert fake_requests.calls == []
    assert extractor.calls == []


def test_source_byte_limit_stops_before_extraction(monkeypatch, tmp_path):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    extractor = FakeExtractor()
    client = TestClient(
        media_audio_extractor_create_app(
            requests_module=FakeRequests(FakeResponse([b"too large"])),
            media_prober=FakeProber(),
            audio_extractor=extractor,
            storage_dir=tmp_path,
        )
    )

    response = client.post(
        "/extract-audio",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourceUrl": "https://r2.test/source",
            "maxBytes": 4,
        },
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Source file is too large"}
    assert extractor.calls == []


def test_extractor_failure_returns_unprocessable_entity(monkeypatch, tmp_path):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    client = TestClient(
        media_audio_extractor_create_app(
            requests_module=FakeRequests(FakeResponse([b"hello"])),
            media_prober=FakeProber(),
            audio_extractor=FailingExtractor(),
            storage_dir=tmp_path,
        )
    )

    response = client.post(
        "/extract-audio",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourceUrl": "https://r2.test/source",
            "maxBytes": 100,
        },
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Failed to extract audio from source file"}
    assert list(tmp_path.glob("*.m4a")) == []


def test_audio_get_rejects_tampered_signature(monkeypatch, tmp_path):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    client = TestClient(
        media_audio_extractor_create_app(
            requests_module=FakeRequests(FakeResponse([])),
            media_prober=FakeProber(),
            audio_extractor=FakeExtractor(),
            storage_dir=tmp_path,
        )
    )
    expires_at = int(time.time()) + 900
    signature = media_audio_extractor_sign_entry("entry", expires_at, "secret")

    tampered_signature = client.get(f"/audio/entry?exp={expires_at}&sig={'0' * 64}")
    tampered_entry = client.get(f"/audio/other?exp={expires_at}&sig={signature}")
    tampered_expiry = client.get(f"/audio/entry?exp={expires_at + 1}&sig={signature}")
    missing_signature = client.get(f"/audio/entry?exp={expires_at}")

    assert tampered_signature.status_code == 403
    assert tampered_entry.status_code == 403
    assert tampered_expiry.status_code == 403
    assert missing_signature.status_code == 403


def test_audio_get_rejects_expired_link(monkeypatch, tmp_path):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    client = TestClient(
        media_audio_extractor_create_app(
            requests_module=FakeRequests(FakeResponse([])),
            media_prober=FakeProber(),
            audio_extractor=FakeExtractor(),
            storage_dir=tmp_path,
        )
    )
    expires_at = int(time.time()) - 1
    signature = media_audio_extractor_sign_entry("entry", expires_at, "secret")

    response = client.get(f"/audio/entry?exp={expires_at}&sig={signature}")

    assert response.status_code == 403
    assert response.json() == {"detail": "Audio link has expired"}


def test_cleanup_removes_only_expired_entries(tmp_path):
    now = int(time.time())
    expired_path = tmp_path / f"aaa-{now - 10}.m4a"
    live_path = tmp_path / f"bbb-{now + 10}.m4a"
    unrelated_path = tmp_path / "notes.txt"
    unparsable_path = tmp_path / "weird.m4a"
    for path in [expired_path, live_path, unrelated_path, unparsable_path]:
        path.write_bytes(b"data")

    media_audio_extractor_cleanup_expired_entries(tmp_path, now)

    assert not expired_path.exists()
    assert live_path.exists()
    assert unrelated_path.exists()
    assert unparsable_path.exists()
