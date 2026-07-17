const DOWNLOAD_URL_EXPIRES_SECONDS = 15 * 60;
const MODAL_MAX_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 900_000;
const MISTRAL_TRANSCRIPTION_MODEL = "voxtral-mini-latest";
const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";
const OPENAI_CHAT_MODEL = "gpt-4.1-mini";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OUTBOUND_RETRY_ATTEMPTS = 2;
const OUTBOUND_RETRY_DELAY_MS = 5000;
const TRANSCRIPT_TRUNCATION_NOTICE = "\n\n_Transcript truncated to fit the output size limit._";
const NO_SPEECH_BODY = "_No speech detected._";

const SUMMARY_SYSTEM_PROMPT =
	"Summarize transcripts of uploaded audio and video recordings for an app file tree. Write concise, useful Markdown covering the topics, decisions, action items, and speakers when known. Return raw Markdown without wrapping it in a code fence.";

/** @param {unknown} value */
function normalizeContentType(value) {
	return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : null;
}

/** @param {unknown} contentType */
export function mediaKind(contentType) {
	switch (normalizeContentType(contentType)) {
		case "video/mp4":
		case "video/webm":
		case "video/mpeg":
		case "video/quicktime":
			return "video";
		case "audio/mpeg":
		case "audio/wav":
		case "audio/x-wav":
		case "audio/mp4":
		case "audio/x-m4a":
		case "audio/flac":
		case "audio/ogg":
			return "audio";
		default:
			return null;
	}
}

function skipped() {
	return new Response(null, {
		status: 204,
		headers: { "X-Bonobo-Skipped": "unsupported_content_type" },
	});
}

/** @param {unknown} body */
function json(body, status = 200) {
	return Response.json(body, { status });
}

/** @param {import("bonobo-plugin-sdk").Request} request */
async function readEvent(request) {
	try {
		return /** @type {import("bonobo-plugin-sdk").BonoboUploadCompletedEvent} */ (await request.json());
	} catch {
		return null;
	}
}

/** @param {import("bonobo-plugin-sdk").BonoboUploadCompletedEvent} event */
function getSource(event) {
	const source = event && typeof event === "object" ? event.source : null;
	if (
		!source ||
		typeof source !== "object" ||
		typeof source.fileNodeId !== "string" ||
		typeof source.name !== "string" ||
		typeof source.path !== "string"
	) {
		return null;
	}

	return source;
}

/**
 * @param {import("bonobo-plugin-sdk").BonoboEnv} env
 * @param {string} name
 */
async function requireSecret(env, name) {
	const value = await env.BONOBO.secrets.get(name);
	if (!value) {
		throw new Error(`${name} secret is not configured`);
	}
	return value;
}

/**
 * @param {string} text
 * @param {string} serviceName
 */
function parseJson(text, serviceName) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${serviceName} returned invalid JSON`);
	}
}

/** @param {string} text */
function unwrapMarkdown(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
	return fenced?.[1]?.trim() ?? trimmed;
}

/** @param {string} text */
function utf8ByteLength(text) {
	return new TextEncoder().encode(text).length;
}

/**
 * @param {string} text
 * @param {number} maxBytes
 */
function truncateToBytes(text, maxBytes) {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) {
		return text;
	}
	return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�+$/u, "");
}

/** @param {number} ms */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs JSON to one of the public Bonobo host APIs and returns the parsed response body.
 * @param {import("bonobo-plugin-sdk").BonoboEnv} env
 * @param {string} path
 * @param {unknown} body
 */
async function hostFetch(env, path, body) {
	const response = await fetch(`${env.BONOBO.host.apiOrigin}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.BONOBO.host.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`Host API ${path} returned HTTP ${response.status}`);
	}
	return parseJson(await response.text(), `Host API ${path}`);
}

/**
 * @param {import("bonobo-plugin-sdk").BonoboEnv} env
 * @param {string} fileNodeId
 */
async function sourceDownloadUrl(env, fileNodeId) {
	const result = await hostFetch(env, "/api/v1/files/download-urls", {
		fileNodeIds: [fileNodeId],
		expiresInSeconds: DOWNLOAD_URL_EXPIRES_SECONDS,
	});
	const item = result?.items?.[0];
	if (!item || typeof item.url !== "string") {
		throw new Error("Source download URL is unavailable");
	}
	return item.url;
}

/**
 * @param {{ url: string, method: string, headers: Record<string, string>, body?: string }} args
 * @param {(status: number) => boolean} isRetryableStatus
 */
async function fetchWithRetry(args, isRetryableStatus) {
	let response = null;
	for (let attempt = 0; attempt < OUTBOUND_RETRY_ATTEMPTS; attempt += 1) {
		const lastAttempt = attempt === OUTBOUND_RETRY_ATTEMPTS - 1;
		try {
			response = await fetch(args.url, { method: args.method, headers: args.headers, body: args.body });
		} catch (error) {
			if (lastAttempt) {
				throw error;
			}
			await sleep(OUTBOUND_RETRY_DELAY_MS);
			continue;
		}
		if (!isRetryableStatus(response.status) || lastAttempt) {
			break;
		}
		await sleep(OUTBOUND_RETRY_DELAY_MS);
	}
	return response;
}

/**
 * @param {{ modalUrl: string, modalToken: string, sourceUrl: string, contentType: string | null }} args
 */
export async function extractAudioUrl({ modalUrl, modalToken, sourceUrl, contentType }) {
	const response = await fetchWithRetry(
		{
			url: modalUrl,
			method: "POST",
			headers: {
				Authorization: `Bearer ${modalToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sourceUrl, contentType, maxBytes: MODAL_MAX_SOURCE_BYTES }),
		},
		(status) => status >= 500,
	);
	if (!response || !response.ok) {
		if (response && response.status >= 500) {
			throw new Error(`Modal audio extraction failed (HTTP ${response.status})`);
		}
		throw new Error(`Modal audio extractor rejected the request (HTTP ${response?.status ?? "unknown"})`);
	}

	const payload = parseJson(await response.text(), "Modal audio extractor");
	if (!payload || typeof payload.audioUrl !== "string") {
		throw new Error("Modal audio extractor returned no audio URL");
	}
	return {
		audioUrl: payload.audioUrl,
		expiresAt: typeof payload.expiresAt === "number" ? payload.expiresAt : null,
		bytes: typeof payload.bytes === "number" ? payload.bytes : null,
		durationSeconds: typeof payload.durationSeconds === "number" ? payload.durationSeconds : null,
	};
}

/**
 * @param {string} boundary
 * @param {Array<[string, string]>} fields
 */
function multipartTextBody(boundary, fields) {
	const parts = fields.map(
		([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
	);
	return `${parts.join("")}--${boundary}--\r\n`;
}

/**
 * @param {{ apiKey: string, fileUrl: string }} args
 */
export async function transcribeWithMistral({ apiKey, fileUrl }) {
	const boundary = `bonobo-plugin-${crypto.randomUUID()}`;
	const response = await fetchWithRetry(
		{
			url: MISTRAL_TRANSCRIPTION_URL,
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			body: multipartTextBody(boundary, [
				["model", MISTRAL_TRANSCRIPTION_MODEL],
				["file_url", fileUrl],
				["diarize", "true"],
				["timestamp_granularities", "segment"],
			]),
		},
		(status) => status === 429 || status >= 500,
	);
	if (!response || !response.ok) {
		if (response && (response.status === 429 || response.status >= 500)) {
			throw new Error(`Mistral transcription failed (HTTP ${response.status})`);
		}
		throw new Error(`Mistral rejected the media (HTTP ${response?.status ?? "unknown"})`);
	}

	return parseJson(await response.text(), "Mistral transcription");
}

/**
 * @typedef {{ speaker: string | null, startMs: number, endMs: number, text: string }} TranscriptSegment
 * @typedef {{ language: string | null, durationMs: number | null, text: string, segments: TranscriptSegment[] }} NormalizedTranscription
 */

/** @param {unknown} speakerId */
function speakerLabel(speakerId) {
	if (typeof speakerId !== "string" || speakerId.length === 0) {
		return null;
	}
	const numbered = speakerId.match(/^speaker_(\d+)$/u);
	return numbered ? `Speaker ${numbered[1]}` : speakerId;
}

/**
 * @param {any} payload
 * @returns {NormalizedTranscription}
 */
export function normalizeMistralTranscription(payload) {
	const record = payload && typeof payload === "object" ? payload : {};
	const text = typeof record.text === "string" ? record.text.trim() : "";
	const segments = [];
	if (Array.isArray(record.segments)) {
		for (const segment of record.segments) {
			if (!segment || typeof segment !== "object" || typeof segment.text !== "string") {
				continue;
			}
			const segmentText = segment.text.trim();
			if (!segmentText || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
				continue;
			}
			segments.push({
				speaker: speakerLabel(segment.speaker_id),
				startMs: Math.round(segment.start * 1000),
				endMs: Math.round(segment.end * 1000),
				text: segmentText,
			});
		}
	}
	const usage = record.usage && typeof record.usage === "object" ? record.usage : {};
	const durationMs = Number.isFinite(usage.prompt_audio_seconds)
		? Math.round(usage.prompt_audio_seconds * 1000)
		: segments.length > 0
			? segments[segments.length - 1].endMs
			: null;
	return {
		language: typeof record.language === "string" ? record.language : null,
		durationMs,
		text,
		segments,
	};
}

/** @param {number} ms */
export function formatTimestamp(ms) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

/** @param {TranscriptSegment[]} segments */
function mergeSegmentsIntoTurns(segments) {
	/** @type {Array<{ speaker: string | null, startMs: number, endMs: number, texts: string[] }>} */
	const turns = [];
	for (const segment of segments) {
		const lastTurn = turns[turns.length - 1];
		if (lastTurn && lastTurn.speaker === segment.speaker) {
			lastTurn.endMs = segment.endMs;
			lastTurn.texts.push(segment.text);
			continue;
		}
		turns.push({ speaker: segment.speaker, startMs: segment.startMs, endMs: segment.endMs, texts: [segment.text] });
	}
	return turns;
}

/** @param {{ sourceName: string, model: string, normalized: NormalizedTranscription }} args */
export function transcriptMarkdown({ sourceName, model, normalized }) {
	const metaParts = [`Model: ${model}`];
	if (normalized.durationMs !== null) {
		metaParts.push(`Duration: ${formatTimestamp(normalized.durationMs)}`);
	}
	const header = `# Transcript — ${sourceName}\n\n_${metaParts.join(" · ")}_`;
	const body =
		normalized.segments.length > 0
			? mergeSegmentsIntoTurns(normalized.segments)
					.map(
						(turn) =>
							`## ${turn.speaker ?? "Speaker ?"} — [${formatTimestamp(turn.startMs)} – ${formatTimestamp(turn.endMs)}]\n\n${turn.texts.join(" ")}`,
					)
					.join("\n\n")
			: normalized.text || NO_SPEECH_BODY;
	const markdown = `${header}\n\n${body}`;
	if (utf8ByteLength(markdown) <= MAX_MARKDOWN_BYTES) {
		return markdown;
	}
	const budget = MAX_MARKDOWN_BYTES - utf8ByteLength(TRANSCRIPT_TRUNCATION_NOTICE);
	return `${truncateToBytes(markdown, budget)}${TRANSCRIPT_TRUNCATION_NOTICE}`;
}

/** @param {NormalizedTranscription} normalized */
function normalizedTranscriptText(normalized) {
	if (normalized.segments.length === 0) {
		return normalized.text;
	}
	return normalized.segments.map((segment) => `${segment.speaker ?? "Speaker ?"}: ${segment.text}`).join("\n");
}

/** @param {{ apiKey: string, normalized: NormalizedTranscription, sourceName: string }} args */
export async function summarizeTranscript({ apiKey, normalized, sourceName }) {
	const response = await fetchWithRetry(
		{
			url: OPENAI_CHAT_COMPLETIONS_URL,
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: OPENAI_CHAT_MODEL,
				messages: [
					{ role: "system", content: SUMMARY_SYSTEM_PROMPT },
					{
						role: "user",
						content: `Summarize the transcript of the uploaded file named ${sourceName}.\n\nTranscript:\n\n${normalizedTranscriptText(normalized)}`,
					},
				],
				max_completion_tokens: 1200,
			}),
		},
		(status) => status === 429 || status >= 500,
	);
	if (!response || !response.ok) {
		throw new Error(`OpenAI summary failed (HTTP ${response?.status ?? "unknown"})`);
	}

	const payload = parseJson(await response.text(), "OpenAI summary");
	const choices = payload && typeof payload === "object" && Array.isArray(payload.choices) ? payload.choices : [];
	const message = choices[0] && typeof choices[0] === "object" ? choices[0].message : null;
	const content = message && typeof message === "object" ? message.content : null;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error("OpenAI returned no summary text");
	}
	return unwrapMarkdown(content);
}

/** @type {import("bonobo-plugin-sdk").BonoboPluginHandler} */
export default {
	async fetch(request, env) {
		const event = await readEvent(request);
		const source = event ? getSource(event) : null;
		if (!event || !source) {
			return json({ error: "Upload source is missing" }, 400);
		}

		const kind = mediaKind(source.contentType);
		if (!kind) {
			return skipped();
		}

		// Opt into the workspace activity feed first, so users can watch the run — including a
		// failure while reading secrets. The host links every file this run touches or writes to
		// the activity and closes it with the run's outcome.
		await hostFetch(env, "/api/v1/activities/start", { title: `Transcribing ${source.name}` });

		const mistralApiKey = await requireSecret(env, "MISTRAL_API_KEY");
		const openaiApiKey = await requireSecret(env, "OPENAI_API_KEY");
		let modalSecrets = null;
		if (kind === "video") {
			modalSecrets = {
				modalUrl: await requireSecret(env, "MODAL_MEDIA_AUDIO_URL"),
				modalToken: await requireSecret(env, "MODAL_TOKEN"),
			};
		}

		// Absolute siblings of the upload: /folder/meeting.mp4 -> /folder/meeting.mp4.transcript.md.
		const transcriptPath = `${source.path}.transcript.md`;
		const summaryPath = `${source.path}.summary.md`;
		// Create the output files empty right away — after every secret is known to exist, so a
		// missing secret still fails before any file appears — and let the user see where the
		// transcript and summary will land while transcription runs. The writes below fill these
		// same nodes in place.
		await hostFetch(env, "/api/v1/files/touch", { paths: [transcriptPath, summaryPath] });

		const sourceUrl = await sourceDownloadUrl(env, source.fileNodeId);
		let fileUrl = sourceUrl;
		if (modalSecrets) {
			const extracted = await extractAudioUrl({
				modalUrl: modalSecrets.modalUrl,
				modalToken: modalSecrets.modalToken,
				sourceUrl,
				contentType: source.contentType,
			});
			fileUrl = extracted.audioUrl;
		}
		const transcription = await transcribeWithMistral({ apiKey: mistralApiKey, fileUrl });
		const normalized = normalizeMistralTranscription(transcription);
		const model =
			transcription && typeof transcription.model === "string" ? transcription.model : MISTRAL_TRANSCRIPTION_MODEL;

		await hostFetch(env, "/api/v1/files/write", {
			path: transcriptPath,
			content: transcriptMarkdown({ sourceName: source.name, model, normalized }),
			overwrite: "replace",
		});

		const noSpeech = normalized.text.length === 0 && normalized.segments.length === 0;
		const summary = noSpeech
			? NO_SPEECH_BODY
			: await summarizeTranscript({ apiKey: openaiApiKey, normalized, sourceName: source.name });
		await hostFetch(env, "/api/v1/files/write", {
			path: summaryPath,
			content: `# Summary — ${source.name}\n\n${summary}`,
			overwrite: "replace",
		});

		return json({ ok: true, files: [transcriptPath, summaryPath] });
	},
};
