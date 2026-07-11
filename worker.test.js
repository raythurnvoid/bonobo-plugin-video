import { afterEach, describe, expect, it, vi } from "vitest";

import worker, {
	formatTimestamp,
	mediaKind,
	normalizeMistralTranscription,
	transcriptMarkdown,
} from "./dist/backend/worker.js";
import m4aDiarized from "./test/fixtures/mistral-m4a-diarized.json";
import wavDiarized from "./test/fixtures/mistral-wav-diarized.json";
import wavPlain from "./test/fixtures/mistral-wav-plain.json";

const HOST_API_ORIGIN = "https://host.test";
const DOWNLOAD_URL_API = `${HOST_API_ORIGIN}/api/v1/files/download-url`;
const FILES_WRITE_API = `${HOST_API_ORIGIN}/api/v1/files/write`;
const SOURCE_URL = "https://r2.example.com/uploads/source-object?signature=source-sig";
const MODAL_URL = "https://ray-thurne-void--bonobo-senate-press-media-audio-asgi.modal.run/extract";
const MODAL_AUDIO_URL = "https://modal-bucket.example.com/audio.wav?signature=audio-sig";
const MISTRAL_URL_PREFIX = "https://api.mistral.ai/";
const OPENAI_URL_PREFIX = "https://api.openai.com/";

function uploadRequest(source = {}) {
	const mergedSource = {
		fileNodeId: "node-1",
		assetId: "asset-1",
		name: "meeting.mp4",
		contentType: "video/mp4",
		size: 1234,
		...source,
	};
	return new Request("https://plugin.local/__bonobo/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			event: "files.upload.completed",
			pluginRunId: "run-1",
			source: { path: `/recordings/${mergedSource.name}`, ...mergedSource },
		}),
	});
}

function modalResponse() {
	return Response.json({ audioUrl: MODAL_AUDIO_URL, expiresAt: 1770000000000, bytes: 4096, durationSeconds: 38 });
}

function mistralResponse(payload) {
	return Response.json(payload);
}

function openaiResponse(text) {
	return Response.json({ choices: [{ message: { content: text } }] });
}

function errorResponse(status) {
	return new Response("", { status });
}

function stubEnv({ secrets = {} } = {}) {
	const resolvedSecrets = {
		MISTRAL_API_KEY: "mistral-key",
		OPENAI_API_KEY: "openai-key",
		MODAL_MEDIA_AUDIO_URL: MODAL_URL,
		MODAL_TOKEN: "modal-token",
		...secrets,
	};
	return {
		BONOBO: {
			secrets: {
				get: async (name) => resolvedSecrets[name] ?? null,
			},
			host: { apiOrigin: HOST_API_ORIGIN, token: "run-token" },
		},
	};
}

function capturedHostCall(init) {
	return { headers: init.headers, body: JSON.parse(String(init.body)) };
}

function capturedServiceCall(url, init) {
	return { url, headers: init.headers, body: String(init.body) };
}

// Mocks global fetch: host API origin calls (download URL, file write) are tracked separately
// from the third-party service calls (Modal, Mistral, OpenAI) in `fetches`. Service responders are
// thunks so retries produce a fresh single-use Response each attempt.
function stubFetch({ modal, mistral, openai } = {}) {
	const downloadUrlCalls = [];
	const writeCalls = [];
	const fetches = [];
	const respondModal = modal ?? (() => modalResponse());
	const respondMistral = mistral ?? (() => mistralResponse(wavDiarized));
	const respondOpenai = openai ?? (() => openaiResponse("A concise summary."));
	const fetchMock = vi.fn(async (url, init) => {
		if (url === DOWNLOAD_URL_API) {
			downloadUrlCalls.push(capturedHostCall(init));
			return Response.json({ fileNodeId: "node-1", url: SOURCE_URL, expiresAt: Date.now() + 900_000 });
		}
		if (url === FILES_WRITE_API) {
			const call = capturedHostCall(init);
			writeCalls.push(call);
			return Response.json({ path: call.body.path, nodeId: "node-2", contentType: "text/markdown;charset=utf-8" });
		}
		if (url.startsWith(MODAL_URL)) {
			fetches.push(capturedServiceCall(url, init));
			return respondModal();
		}
		if (url.startsWith(MISTRAL_URL_PREFIX)) {
			fetches.push(capturedServiceCall(url, init));
			return respondMistral();
		}
		if (url.startsWith(OPENAI_URL_PREFIX)) {
			fetches.push(capturedServiceCall(url, init));
			return respondOpenai();
		}
		throw new Error(`Unexpected fetch URL: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, downloadUrlCalls, writeCalls, fetches };
}

async function fetchExpectingError(env, request) {
	const captured = worker.fetch(request, env).catch((error) => error);
	await vi.runAllTimersAsync();
	const error = await captured;
	expect(error).toBeInstanceOf(Error);
	return error;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("mediaKind", () => {
	it("classifies the supported video types", () => {
		expect(mediaKind("video/mp4")).toBe("video");
		expect(mediaKind("video/webm")).toBe("video");
		expect(mediaKind("video/mpeg")).toBe("video");
		expect(mediaKind("video/quicktime")).toBe("video");
	});

	it("classifies the supported audio types", () => {
		expect(mediaKind("audio/mpeg")).toBe("audio");
		expect(mediaKind("audio/wav")).toBe("audio");
		expect(mediaKind("audio/x-wav")).toBe("audio");
		expect(mediaKind("audio/mp4")).toBe("audio");
		expect(mediaKind("audio/x-m4a")).toBe("audio");
		expect(mediaKind("audio/flac")).toBe("audio");
		expect(mediaKind("audio/ogg")).toBe("audio");
	});

	it("normalizes casing and parameters", () => {
		expect(mediaKind("audio/wav; codecs=1")).toBe("audio");
		expect(mediaKind("Video/MP4")).toBe("video");
	});

	it("returns null for unsupported types", () => {
		expect(mediaKind("image/png")).toBe(null);
		expect(mediaKind("application/pdf")).toBe(null);
		expect(mediaKind(null)).toBe(null);
		expect(mediaKind(undefined)).toBe(null);
	});
});

describe("normalizeMistralTranscription", () => {
	it("normalizes the diarized wav fixture", () => {
		const normalized = normalizeMistralTranscription(wavDiarized);
		expect(normalized.language).toBe(null);
		expect(normalized.durationMs).toBe(38_000);
		expect(normalized.text.startsWith("Hello, this is Speaker 1.")).toBe(true);
		expect(normalized.segments).toHaveLength(9);
		expect(normalized.segments[0]).toEqual({
			speaker: "Speaker 1",
			startMs: 100,
			endMs: 2000,
			text: "Hello, this is Speaker 1.",
		});
		expect(normalized.segments[2].speaker).toBe("Speaker 2");
		expect(normalized.segments[8]).toEqual({
			speaker: "Speaker 2",
			startMs: 34_900,
			endMs: 38_200,
			text: "I will send the final marketing plan to the whole team on Friday.",
		});
	});

	it("normalizes the diarized m4a fixture", () => {
		const normalized = normalizeMistralTranscription(m4aDiarized);
		expect(normalized.durationMs).toBe(38_000);
		expect(normalized.segments).toHaveLength(9);
		expect(normalized.segments.map((segment) => segment.speaker)).toEqual([
			"Speaker 1",
			"Speaker 1",
			"Speaker 2",
			"Speaker 2",
			"Speaker 1",
			"Speaker 2",
			"Speaker 1",
			"Speaker 2",
			"Speaker 2",
		]);
	});

	it("normalizes the plain fixture without segments", () => {
		const normalized = normalizeMistralTranscription(wavPlain);
		expect(normalized.segments).toEqual([]);
		expect(normalized.text.length).toBeGreaterThan(0);
		expect(normalized.durationMs).toBe(38_000);
		expect(normalized.language).toBe(null);
	});

	it("returns an empty result for error-shaped payloads", () => {
		expect(normalizeMistralTranscription({ object: "error", message: "Unauthorized", code: 401 })).toEqual({
			language: null,
			durationMs: null,
			text: "",
			segments: [],
		});
		expect(normalizeMistralTranscription(null)).toEqual({
			language: null,
			durationMs: null,
			text: "",
			segments: [],
		});
		expect(
			normalizeMistralTranscription({ text: 42, segments: [{ text: "no timing" }, null, "bogus"], usage: "nope" }),
		).toEqual({ language: null, durationMs: null, text: "", segments: [] });
	});
});

describe("formatTimestamp", () => {
	it("formats as HH:MM:SS", () => {
		expect(formatTimestamp(0)).toBe("00:00:00");
		expect(formatTimestamp(3000)).toBe("00:00:03");
		expect(formatTimestamp(72_000)).toBe("00:01:12");
		expect(formatTimestamp(3_661_000)).toBe("01:01:01");
	});
});

describe("transcriptMarkdown", () => {
	it("merges consecutive same-speaker segments into turns", () => {
		const markdown = transcriptMarkdown({
			sourceName: "meeting.mp4",
			model: "voxtral-mini-latest",
			normalized: normalizeMistralTranscription(wavDiarized),
		});
		expect(markdown.startsWith("# Transcript — meeting.mp4\n\n_Model: voxtral-mini-latest · Duration: 00:00:38_")).toBe(
			true,
		);
		expect(markdown).toContain(
			"## Speaker 1 — [00:00:00 – 00:00:07]\n\nHello, this is Speaker 1. Today I want to talk about the quarterly budget for the Penguin Research Station.",
		);
		expect(markdown).toContain("## Speaker 2 — [00:00:08 – 00:00:16]");
		expect(markdown.match(/^## /gmu)).toHaveLength(6);
	});

	it("labels unknown speakers as Speaker ?", () => {
		const markdown = transcriptMarkdown({
			sourceName: "call.wav",
			model: "voxtral-mini-latest",
			normalized: {
				language: null,
				durationMs: 4000,
				text: "Hello there. Still me.",
				segments: [
					{ speaker: null, startMs: 0, endMs: 2000, text: "Hello there." },
					{ speaker: null, startMs: 2000, endMs: 4000, text: "Still me." },
				],
			},
		});
		expect(markdown).toContain("## Speaker ? — [00:00:00 – 00:00:04]\n\nHello there. Still me.");
	});

	it("falls back to the full text when there are no segments", () => {
		const markdown = transcriptMarkdown({
			sourceName: "call.wav",
			model: "voxtral-mini-latest",
			normalized: normalizeMistralTranscription(wavPlain),
		});
		expect(markdown.startsWith("# Transcript — call.wav\n\n_Model: voxtral-mini-latest · Duration: 00:00:38_")).toBe(
			true,
		);
		expect(markdown).not.toContain("## ");
		expect(markdown).toContain("Hello, this is Speaker 1.");
	});

	it("omits the duration when it is unknown and reports no speech", () => {
		const markdown = transcriptMarkdown({
			sourceName: "silent.wav",
			model: "voxtral-mini-latest",
			normalized: { language: null, durationMs: null, text: "", segments: [] },
		});
		expect(markdown).toBe("# Transcript — silent.wav\n\n_Model: voxtral-mini-latest_\n\n_No speech detected._");
	});

	it("truncates oversized transcripts with a notice", () => {
		const markdown = transcriptMarkdown({
			sourceName: "long.mp4",
			model: "voxtral-mini-latest",
			normalized: {
				language: null,
				durationMs: 7_200_000,
				text: "",
				segments: [{ speaker: "Speaker 1", startMs: 0, endMs: 7_200_000, text: "word ".repeat(200_000).trim() }],
			},
		});
		expect(new TextEncoder().encode(markdown).length).toBeLessThanOrEqual(900_000);
		expect(markdown.endsWith("\n\n_Transcript truncated to fit the output size limit._")).toBe(true);
	});
});

describe("worker fetch", () => {
	it("skips unsupported content types", async () => {
		const { fetches, writeCalls } = stubFetch();
		const env = stubEnv();
		const response = await worker.fetch(uploadRequest({ name: "photo.png", contentType: "image/png" }), env);
		expect(response.status).toBe(204);
		expect(response.headers.get("X-Bonobo-Skipped")).toBe("unsupported_content_type");
		expect(writeCalls).toHaveLength(0);
		expect(fetches).toHaveLength(0);
	});

	it("extracts audio through Modal before transcribing video uploads", async () => {
		const { fetches, writeCalls, downloadUrlCalls } = stubFetch();
		const env = stubEnv();
		const response = await worker.fetch(uploadRequest(), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			files: ["/recordings/meeting.mp4.transcript.md", "/recordings/meeting.mp4.summary.md"],
		});

		expect(downloadUrlCalls).toHaveLength(1);
		expect(downloadUrlCalls[0].headers.Authorization).toBe("Bearer run-token");
		expect(downloadUrlCalls[0].body).toEqual({ fileNodeId: "node-1", expiresInSeconds: 900 });

		expect(fetches).toHaveLength(3);
		expect(fetches[0].url).toBe(MODAL_URL);
		expect(fetches[0].headers.Authorization).toBe("Bearer modal-token");
		expect(JSON.parse(fetches[0].body)).toEqual({
			sourceUrl: SOURCE_URL,
			contentType: "video/mp4",
			maxBytes: 200 * 1024 * 1024,
		});
		expect(fetches[1].url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
		expect(fetches[1].headers.Authorization).toBe("Bearer mistral-key");
		expect(fetches[1].body).toContain('name="file_url"\r\n\r\n' + MODAL_AUDIO_URL);
		expect(fetches[1].body).toContain('name="model"\r\n\r\nvoxtral-mini-latest');
		expect(fetches[1].body).toContain('name="diarize"\r\n\r\ntrue');
		expect(fetches[1].body).toContain('name="timestamp_granularities"\r\n\r\nsegment');
		expect(fetches[1].body).not.toContain(SOURCE_URL);
		expect(fetches[2].url).toBe("https://api.openai.com/v1/chat/completions");

		expect(writeCalls).toHaveLength(2);
		expect(writeCalls[0].headers.Authorization).toBe("Bearer run-token");
		expect(writeCalls[0].body.path).toBe("/recordings/meeting.mp4.transcript.md");
		expect(writeCalls[0].body.content).toContain("## Speaker 1 — [00:00:00 – 00:00:07]");
		expect(writeCalls[0].body.overwrite).toBe("replace");
		expect(writeCalls[1].body.path).toBe("/recordings/meeting.mp4.summary.md");
		expect(writeCalls[1].body.content).toBe("# Summary — meeting.mp4\n\nA concise summary.");
	});

	it("sends audio uploads straight to Mistral without Modal", async () => {
		const { fetches, writeCalls } = stubFetch();
		const env = stubEnv();
		const response = await worker.fetch(uploadRequest({ name: "call.wav", contentType: "audio/wav" }), env);
		expect(response.status).toBe(200);
		expect(fetches).toHaveLength(2);
		expect(fetches[0].url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
		expect(fetches[0].body).toContain('name="file_url"\r\n\r\n' + SOURCE_URL);
		expect(fetches[1].url).toBe("https://api.openai.com/v1/chat/completions");
		expect(writeCalls.map((call) => call.body.path)).toEqual([
			"/recordings/call.wav.transcript.md",
			"/recordings/call.wav.summary.md",
		]);
	});

	it("fails before any write when MISTRAL_API_KEY is missing", async () => {
		const { fetches, writeCalls } = stubFetch();
		const env = stubEnv({ secrets: { MISTRAL_API_KEY: null } });
		await expect(worker.fetch(uploadRequest(), env)).rejects.toThrow("MISTRAL_API_KEY secret is not configured");
		expect(writeCalls).toHaveLength(0);
		expect(fetches).toHaveLength(0);
	});

	it("fails deterministically without retry when Modal returns 413", async () => {
		vi.useFakeTimers();
		const { fetches, writeCalls } = stubFetch({ modal: () => errorResponse(413) });
		const env = stubEnv();
		const error = await fetchExpectingError(env, uploadRequest());
		expect(error.message).toBe("Modal audio extractor rejected the request (HTTP 413)");
		expect(fetches).toHaveLength(1);
		expect(writeCalls).toHaveLength(0);
	});

	it("retries Mistral once on HTTP 500 and then fails", async () => {
		vi.useFakeTimers();
		const { fetches, writeCalls } = stubFetch({ mistral: () => errorResponse(500) });
		const env = stubEnv();
		const error = await fetchExpectingError(env, uploadRequest({ name: "call.wav", contentType: "audio/wav" }));
		expect(error.message).toBe("Mistral transcription failed (HTTP 500)");
		expect(fetches).toHaveLength(2);
		expect(fetches.every((fetchArgs) => fetchArgs.url.startsWith(MISTRAL_URL_PREFIX))).toBe(true);
		expect(writeCalls).toHaveLength(0);
	});

	it("keeps the transcript when the summary fails after it is written", async () => {
		vi.useFakeTimers();
		const { fetches, writeCalls } = stubFetch({ openai: () => errorResponse(500) });
		const env = stubEnv();
		const error = await fetchExpectingError(env, uploadRequest({ name: "call.wav", contentType: "audio/wav" }));
		expect(error.message).toBe("OpenAI summary failed (HTTP 500)");
		expect(writeCalls).toHaveLength(1);
		expect(writeCalls[0].body.path).toBe("/recordings/call.wav.transcript.md");
		expect(fetches.filter((fetchArgs) => fetchArgs.url.startsWith(OPENAI_URL_PREFIX))).toHaveLength(2);
	});

	it("writes no-speech transcript and summary without calling OpenAI", async () => {
		const { fetches, writeCalls } = stubFetch({
			mistral: () =>
				mistralResponse({
					model: "voxtral-mini-latest",
					text: "",
					language: null,
					segments: [],
					usage: { prompt_audio_seconds: 2 },
				}),
		});
		const env = stubEnv();
		const response = await worker.fetch(uploadRequest({ name: "silence.wav", contentType: "audio/wav" }), env);
		expect(response.status).toBe(200);
		expect(fetches).toHaveLength(1);
		expect(fetches[0].url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
		expect(writeCalls).toHaveLength(2);
		expect(writeCalls[0].body.content).toContain("_No speech detected._");
		expect(writeCalls[1].body.content).toBe("# Summary — silence.wav\n\n_No speech detected._");
	});
});
