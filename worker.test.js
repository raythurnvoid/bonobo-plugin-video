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

const SOURCE_URL = "https://r2.example.com/uploads/source-object?signature=source-sig";
const MODAL_URL = "https://ray-thurne-void--bonobo-senate-press-media-audio-asgi.modal.run/extract";
const MODAL_AUDIO_URL = "https://modal-bucket.example.com/audio.wav?signature=audio-sig";
const MISTRAL_URL_PREFIX = "https://api.mistral.ai/";
const OPENAI_URL_PREFIX = "https://api.openai.com/";

function uploadRequest(source = {}) {
	return new Request("https://plugin.local/__bonobo/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			event: "files.upload.completed",
			pluginRunId: "run-1",
			source: {
				fileNodeId: "node-1",
				assetId: "asset-1",
				name: "meeting.mp4",
				contentType: "video/mp4",
				size: 1234,
				...source,
			},
		}),
	});
}

function modalResponse() {
	return {
		status: 200,
		ok: true,
		headers: { "Content-Type": "application/json" },
		bodyText: JSON.stringify({ audioUrl: MODAL_AUDIO_URL, expiresAt: 1770000000000, bytes: 4096, durationSeconds: 38 }),
	};
}

function mistralResponse(payload) {
	return {
		status: 200,
		ok: true,
		headers: { "Content-Type": "application/json" },
		bodyText: JSON.stringify(payload),
	};
}

function openaiResponse(text) {
	return {
		status: 200,
		ok: true,
		headers: { "Content-Type": "application/json" },
		bodyText: JSON.stringify({ choices: [{ message: { content: text } }] }),
	};
}

function errorResponse(status) {
	return { status, ok: false, headers: {}, bodyText: "" };
}

function stubEnv({ secrets = {}, respond } = {}) {
	const resolvedSecrets = {
		MISTRAL_API_KEY: "mistral-key",
		OPENAI_API_KEY: "openai-key",
		MODAL_MEDIA_AUDIO_URL: MODAL_URL,
		MODAL_TOKEN: "modal-token",
		...secrets,
	};
	const writes = [];
	const fetches = [];
	const env = {
		BONOBO: {
			secrets: {
				get: async (name) => resolvedSecrets[name] ?? null,
			},
			files: {
				source: {
					temporaryUrl: async () => ({ url: SOURCE_URL, expiresAt: Date.now() + 900_000 }),
				},
				writeMarkdown: async (input) => {
					writes.push(input);
					return null;
				},
			},
			outbound: {
				fetch: async (args) => {
					fetches.push(args);
					return respond(args);
				},
			},
		},
	};
	return { env, writes, fetches };
}

function respondByService({ modal = modalResponse(), mistral = mistralResponse(wavDiarized), openai = openaiResponse("A concise summary.") } = {}) {
	return (args) => {
		if (args.url.startsWith(MODAL_URL)) {
			return modal;
		}
		if (args.url.startsWith(MISTRAL_URL_PREFIX)) {
			return mistral;
		}
		if (args.url.startsWith(OPENAI_URL_PREFIX)) {
			return openai;
		}
		throw new Error(`Unexpected outbound URL: ${args.url}`);
	};
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
		const { env, writes, fetches } = stubEnv({ respond: respondByService() });
		const response = await worker.fetch(uploadRequest({ name: "photo.png", contentType: "image/png" }), env);
		expect(response.status).toBe(204);
		expect(response.headers.get("X-Bonobo-Skipped")).toBe("unsupported_content_type");
		expect(writes).toHaveLength(0);
		expect(fetches).toHaveLength(0);
	});

	it("extracts audio through Modal before transcribing video uploads", async () => {
		const { env, writes, fetches } = stubEnv({ respond: respondByService() });
		const response = await worker.fetch(uploadRequest(), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			files: ["meeting.mp4.transcript.md", "meeting.mp4.summary.md"],
		});

		expect(fetches).toHaveLength(3);
		expect(fetches[0].url).toBe(MODAL_URL);
		expect(fetches[0].headers.Authorization).toBe("Bearer modal-token");
		expect(JSON.parse(fetches[0].bodyText)).toEqual({
			sourceUrl: SOURCE_URL,
			contentType: "video/mp4",
			maxBytes: 200 * 1024 * 1024,
		});
		expect(fetches[1].url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
		expect(fetches[1].headers.Authorization).toBe("Bearer mistral-key");
		expect(fetches[1].bodyText).toContain('name="file_url"\r\n\r\n' + MODAL_AUDIO_URL);
		expect(fetches[1].bodyText).toContain('name="model"\r\n\r\nvoxtral-mini-latest');
		expect(fetches[1].bodyText).toContain('name="diarize"\r\n\r\ntrue');
		expect(fetches[1].bodyText).toContain('name="timestamp_granularities"\r\n\r\nsegment');
		expect(fetches[1].bodyText).not.toContain(SOURCE_URL);
		expect(fetches[2].url).toBe("https://api.openai.com/v1/chat/completions");

		expect(writes).toHaveLength(2);
		expect(writes[0].path).toBe("meeting.mp4.transcript.md");
		expect(writes[0].markdown).toContain("## Speaker 1 — [00:00:00 – 00:00:07]");
		expect(writes[1].path).toBe("meeting.mp4.summary.md");
		expect(writes[1].markdown).toBe("# Summary — meeting.mp4\n\nA concise summary.");
	});

	it("sends audio uploads straight to Mistral without Modal", async () => {
		const { env, writes, fetches } = stubEnv({ respond: respondByService() });
		const response = await worker.fetch(uploadRequest({ name: "call.wav", contentType: "audio/wav" }), env);
		expect(response.status).toBe(200);
		expect(fetches).toHaveLength(2);
		expect(fetches[0].url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
		expect(fetches[0].bodyText).toContain('name="file_url"\r\n\r\n' + SOURCE_URL);
		expect(fetches[1].url).toBe("https://api.openai.com/v1/chat/completions");
		expect(writes.map((write) => write.path)).toEqual(["call.wav.transcript.md", "call.wav.summary.md"]);
	});

	it("fails before any write when MISTRAL_API_KEY is missing", async () => {
		const { env, writes, fetches } = stubEnv({
			secrets: { MISTRAL_API_KEY: null },
			respond: respondByService(),
		});
		await expect(worker.fetch(uploadRequest(), env)).rejects.toThrow("MISTRAL_API_KEY secret is not configured");
		expect(writes).toHaveLength(0);
		expect(fetches).toHaveLength(0);
	});

	it("fails deterministically without retry when Modal returns 413", async () => {
		vi.useFakeTimers();
		const { env, writes, fetches } = stubEnv({
			respond: respondByService({ modal: errorResponse(413) }),
		});
		const error = await fetchExpectingError(env, uploadRequest());
		expect(error.message).toBe("Modal audio extractor rejected the request (HTTP 413)");
		expect(fetches).toHaveLength(1);
		expect(writes).toHaveLength(0);
	});

	it("retries Mistral once on HTTP 500 and then fails", async () => {
		vi.useFakeTimers();
		const { env, writes, fetches } = stubEnv({
			respond: respondByService({ mistral: errorResponse(500) }),
		});
		const error = await fetchExpectingError(env, uploadRequest({ name: "call.wav", contentType: "audio/wav" }));
		expect(error.message).toBe("Mistral transcription failed (HTTP 500)");
		expect(fetches).toHaveLength(2);
		expect(fetches.every((fetchArgs) => fetchArgs.url.startsWith(MISTRAL_URL_PREFIX))).toBe(true);
		expect(writes).toHaveLength(0);
	});

	it("keeps the transcript when the summary fails after it is written", async () => {
		vi.useFakeTimers();
		const { env, writes, fetches } = stubEnv({
			respond: respondByService({ openai: errorResponse(500) }),
		});
		const error = await fetchExpectingError(env, uploadRequest({ name: "call.wav", contentType: "audio/wav" }));
		expect(error.message).toBe("OpenAI summary failed (HTTP 500)");
		expect(writes).toHaveLength(1);
		expect(writes[0].path).toBe("call.wav.transcript.md");
		expect(fetches.filter((fetchArgs) => fetchArgs.url.startsWith(OPENAI_URL_PREFIX))).toHaveLength(2);
	});

	it("writes no-speech transcript and summary without calling OpenAI", async () => {
		const { env, writes, fetches } = stubEnv({
			respond: respondByService({
				mistral: mistralResponse({
					model: "voxtral-mini-latest",
					text: "",
					language: null,
					segments: [],
					usage: { prompt_audio_seconds: 2 },
				}),
			}),
		});
		const response = await worker.fetch(uploadRequest({ name: "silence.wav", contentType: "audio/wav" }), env);
		expect(response.status).toBe(200);
		expect(fetches).toHaveLength(1);
		expect(fetches[0].url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
		expect(writes).toHaveLength(2);
		expect(writes[0].markdown).toContain("_No speech detected._");
		expect(writes[1].markdown).toBe("# Summary — silence.wav\n\n_No speech detected._");
	});
});
