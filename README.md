# Bonobo Video Plugin

First-party Bonobo workspace plugin that generates a diarized transcript (`<name>.transcript.md`) and a summary (`<name>.summary.md`) for uploaded videos and audio recordings.

## How it works

1. The host fires `files.upload.completed` for a supported video (`video/mp4`, `video/webm`, `video/mpeg`, `video/quicktime`) or audio (`audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/x-m4a`, `audio/flac`, `audio/ogg`) upload.
2. The worker requests a presigned download URL for the uploaded source (`POST /api/v1/files/download-urls` with `[source.fileNodeId]`).
3. Video uploads are never sent to Mistral directly: the worker first posts the source URL to a Modal audio extractor, which returns a presigned URL for the extracted audio track. Audio uploads skip Modal and go straight to Mistral.
4. The audio URL is transcribed with Mistral Voxtral (`voxtral-mini-latest`, `diarize=true`, segment timestamps) and rendered as a speaker-turn Markdown transcript. The transcript is written first (`POST /api/v1/files/write` with the absolute sibling path built from `source.path`), so it survives even if summarization fails afterwards.
5. The transcript is summarized with OpenAI `gpt-4.1-mini` and written as the summary file.

All AI calls are plugin-owned outbound requests; the plugin uses no host `ai.*` capabilities.

## Secrets

The plugin reads these secrets at run time and fails with `<NAME> secret is not configured` before writing any output when one is missing:

| Secret                  | Used for                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `MISTRAL_API_KEY`       | Voxtral transcription (`https://api.mistral.ai`)                |
| `OPENAI_API_KEY`        | Transcript summarization (`https://api.openai.com`)             |
| `MODAL_MEDIA_AUDIO_URL` | Modal audio extractor endpoint (video uploads only)             |
| `MODAL_TOKEN`           | Bearer token for the Modal audio extractor (video uploads only) |

Publisher-tier secrets mean the publisher's Mistral/OpenAI/Modal accounts process the media for every installation of this plugin. Workspaces can shadow any of these secrets with installation-tier values to use their own accounts instead.

Mistral audio transcription pricing is about $0.003 per minute of audio (Voxtral Mini Transcribe).

## Modal audio extractor

The Modal component the worker calls for video uploads lives in this repository under `modal/`:

- `modal/media_audio_extractor.py` — the deployable Modal app (`bonobo-senate-press-media-audio`). `POST /extract-audio` takes `{sourceUrl, contentType?, maxBytes}` with a Bearer token checked against the `BONOBO_SENATE_PRESS` Modal secret, streams the video down, extracts the audio track with ffmpeg (`-vn`, AAC stream copy or 96k AAC transcode to m4a), stores it in the `bonobo-senate-press-media-audio-cache` volume, and returns `{audioUrl, expiresAt, bytes, durationSeconds}` where `audioUrl` is an HMAC-signed short-TTL `GET /audio/<id>` link that Mistral fetches directly. `GET /health` returns `{ "ok": true }`.
- `modal/test_media_audio_extractor.py` — pytest suite (ffmpeg and network are faked; no ffmpeg needed in the test image).

Python is not installed on the development machine; both the Modal CLI and pytest run Docker-wrapped:

Run these commands from the parent `t3-chat` repository root. In a standalone plugin clone, omit `--dir plugins/bonobo-plugin-video` but keep Vite Plus and `--ignore-workspace`.

```powershell
vp env exec pnpm --dir plugins/bonobo-plugin-video --ignore-workspace run test:modal
vp env exec pnpm --dir plugins/bonobo-plugin-video --ignore-workspace run deploy:modal
```

The wrapper scripts under `scripts/` mount this repository as `/workspace` and reuse the Modal auth config from `~/.modal-cli`, so a standalone clone of this repository can test and deploy the extractor on its own. The deployed origin is what the `MODAL_MEDIA_AUDIO_URL` publisher secret points at (full `/extract-audio` endpoint URL), with `MODAL_TOKEN` holding the Bearer token.

## Checks

```powershell
vp env exec pnpm --dir plugins/bonobo-plugin-video --ignore-workspace run check
vp env exec pnpm --dir plugins/bonobo-plugin-video --ignore-workspace run test
```

The published plugin entrypoint is `dist/backend/worker.js`, described by `dist/bonobo.plugin.json`. Test fixtures under `test/fixtures/` are real Mistral API responses for synthetic TTS audio and are not part of the published plugin; the same applies to the `modal/` and `scripts/` directories.

## Release

1. Bump `version` in `bonobo.plugin.json`.
2. Run `vp env exec pnpm --dir plugins/bonobo-plugin-video --ignore-workspace run build:manifest` — recomputes the `files[]` hashes from disk, syncs the `package.json` version, and byte-copies the manifest to `dist/bonobo.plugin.json`.
3. Commit and push.
4. Publish the new version from the app's plugin publisher page.
