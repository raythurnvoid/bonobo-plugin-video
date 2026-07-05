import hashlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import modal

app = modal.App("bonobo-senate-press-media-audio")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .uv_pip_install(
        "fastapi",
        "requests",
    )
)

audio_volume = modal.Volume.from_name("bonobo-senate-press-media-audio-cache", create_if_missing=True)
audio_storage_root = "/audio-cache"
audio_entry_ttl_seconds = 900


def media_audio_extractor_sign_entry(entry_id: str, expires_at: int, token: str):
    message = f"{entry_id}:{expires_at}".encode("utf-8")
    return hmac.new(token.encode("utf-8"), message, hashlib.sha256).hexdigest()


def media_audio_extractor_cleanup_expired_entries(storage_dir: Path, now: int):
    for entry_path in storage_dir.glob("*.m4a"):
        _, separator, expires_text = entry_path.stem.rpartition("-")
        if not separator or not expires_text.isdigit():
            continue

        if int(expires_text) < now:
            entry_path.unlink(missing_ok=True)


def media_audio_extractor_probe_source(source_path: Path):
    # Codec and duration are best-effort hints; extraction still runs when probing fails.
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name:format=duration",
            "-of",
            "json",
            str(source_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {"audioCodec": None, "durationSeconds": None}

    try:
        payload = json.loads(result.stdout or "{}")
    except ValueError:
        return {"audioCodec": None, "durationSeconds": None}

    streams = payload.get("streams") or []
    audio_codec = streams[0].get("codec_name") if streams else None
    duration_text = (payload.get("format") or {}).get("duration")
    try:
        duration_seconds = float(duration_text) if duration_text is not None else None
    except (TypeError, ValueError):
        duration_seconds = None

    return {"audioCodec": audio_codec, "durationSeconds": duration_seconds}


def media_audio_extractor_run_ffmpeg(source_path: Path, target_path: Path, audio_codec: str | None):
    # AAC sources stream-copy into the m4a container; everything else transcodes to AAC.
    if audio_codec == "aac":
        codec_args = ["-c:a", "copy"]
    else:
        codec_args = ["-c:a", "aac", "-b:a", "96k"]

    result = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            str(source_path),
            "-vn",
            *codec_args,
            "-movflags",
            "+faststart",
            str(target_path),
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg exited with status {result.returncode}")


def media_audio_extractor_create_app(
    requests_module=None,
    media_prober=None,
    audio_extractor=None,
    storage_dir=None,
    storage_volume=None,
):
    if requests_module is None:
        import requests as requests_module

    if media_prober is None:
        media_prober = media_audio_extractor_probe_source

    if audio_extractor is None:
        audio_extractor = media_audio_extractor_run_ffmpeg

    if storage_dir is None:
        storage_dir = Path(audio_storage_root)

    from fastapi import FastAPI, Header, HTTPException, Request
    from fastapi.responses import FileResponse
    from pydantic import BaseModel, Field

    web_app = FastAPI()
    storage_dir = Path(storage_dir)
    storage_dir.mkdir(parents=True, exist_ok=True)

    class ExtractRequest(BaseModel):
        sourceUrl: str = Field(min_length=1)
        contentType: str | None = Field(default=None, max_length=255)
        maxBytes: int = Field(ge=1, le=1024 * 1024 * 1024)

    class ExtractResponse(BaseModel):
        audioUrl: str
        expiresAt: int
        bytes: int
        durationSeconds: float | None

    def media_audio_extractor_authorize_request(authorization: str | None):
        expected_token = os.environ.get("BONOBO_SENATE_PRESS")
        if not expected_token:
            raise HTTPException(status_code=500, detail="Extractor token is not configured")

        expected_header = f"Bearer {expected_token}"
        if not authorization or not hmac.compare_digest(authorization, expected_header):
            raise HTTPException(status_code=401, detail="Unauthorized")

        return expected_token

    def media_audio_extractor_download_source(request: ExtractRequest, target_path: Path):
        bytes_written = 0
        try:
            with open(target_path, "wb") as file:
                with requests_module.get(request.sourceUrl, stream=True, timeout=(10, 120)) as response:
                    response.raise_for_status()
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue

                        bytes_written += len(chunk)
                        if bytes_written > request.maxBytes:
                            raise HTTPException(status_code=413, detail="Source file is too large")

                        file.write(chunk)
        except requests_module.HTTPError as error:
            raise HTTPException(status_code=422, detail="Failed to download source file") from error
        except requests_module.RequestException as error:
            raise HTTPException(status_code=502, detail="Failed to fetch source file") from error

    @web_app.get("/health")
    def media_audio_extractor_health():
        return {"ok": True}

    @web_app.post("/extract-audio", response_model=ExtractResponse)
    def media_audio_extractor_extract(
        request: ExtractRequest, http_request: Request, authorization: str | None = Header(default=None)
    ):
        token = media_audio_extractor_authorize_request(authorization)

        with tempfile.TemporaryDirectory() as work_dir:
            source_path = Path(work_dir) / "source"
            media_audio_extractor_download_source(request, source_path)
            probe = media_prober(source_path)

            target_path = Path(work_dir) / "audio.m4a"
            try:
                audio_extractor(source_path, target_path, probe["audioCodec"])
            except Exception as error:
                raise HTTPException(status_code=422, detail="Failed to extract audio from source file") from error

            audio_bytes = target_path.stat().st_size
            now = int(time.time())
            entry_id = secrets.token_hex(16)
            expires_at = now + audio_entry_ttl_seconds
            media_audio_extractor_cleanup_expired_entries(storage_dir, now)
            shutil.move(str(target_path), storage_dir / f"{entry_id}-{expires_at}.m4a")
            if storage_volume is not None:
                storage_volume.commit()

        signature = media_audio_extractor_sign_entry(entry_id, expires_at, token)
        base_url = str(http_request.base_url)
        if base_url.startswith("http://") and base_url.endswith(".modal.run/"):
            # Modal terminates TLS at its proxy; signed links must stay https for header-less fetchers.
            base_url = "https://" + base_url.removeprefix("http://")

        return ExtractResponse(
            audioUrl=f"{base_url}audio/{entry_id}?exp={expires_at}&sig={signature}",
            expiresAt=expires_at,
            bytes=audio_bytes,
            durationSeconds=probe["durationSeconds"],
        )

    @web_app.get("/audio/{entry_id}")
    def media_audio_extractor_serve_audio(entry_id: str, exp: str | None = None, sig: str | None = None):
        expected_token = os.environ.get("BONOBO_SENATE_PRESS")
        if not expected_token:
            raise HTTPException(status_code=500, detail="Extractor token is not configured")

        if not exp or not exp.isdigit() or not sig:
            raise HTTPException(status_code=403, detail="Invalid audio link signature")

        expires_at = int(exp)
        expected_signature = media_audio_extractor_sign_entry(entry_id, expires_at, expected_token)
        if not hmac.compare_digest(sig, expected_signature):
            raise HTTPException(status_code=403, detail="Invalid audio link signature")

        if expires_at < int(time.time()):
            raise HTTPException(status_code=403, detail="Audio link has expired")

        if storage_volume is not None:
            storage_volume.reload()

        audio_path = storage_dir / f"{entry_id}-{expires_at}.m4a"
        if not audio_path.exists():
            raise HTTPException(status_code=404, detail="Audio entry not found")

        return FileResponse(audio_path, media_type="audio/mp4")

    return web_app


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("BONOBO_SENATE_PRESS")],
    volumes={audio_storage_root: audio_volume},
    timeout=15 * 60,
)
@modal.asgi_app(label="bonobo-senate-press-media-audio-asgi")
def media_audio_extractor_asgi():
    return media_audio_extractor_create_app(storage_volume=audio_volume)
