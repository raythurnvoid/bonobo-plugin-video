const TEMPORARY_URL_EXPIRES_SECONDS = 15 * 60;
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

function normalizeContentType(value) {
	return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : null;
}

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

function json(body, status = 200) {
	return Response.json(body, { status });
}

async function readEvent(request) {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

function getSource(event) {
	const source = event && typeof event === "object" ? event.source : null;
	if (!source || typeof source !== "object" || typeof source.name !== "string") {
		return null;
	}

	return source;
}

async function requireSecret(env, name) {
	const value = await env.BONOBO.secrets.get(name);
	if (!value) {
		throw new Error(`${name} secret is not configured`);
	}
	return value;
}

function parseJson(text, serviceName) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${serviceName} returned invalid JSON`);
	}
}

function unwrapMarkdown(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
	return fenced?.[1]?.trim() ?? trimmed;
}

function utf8ByteLength(text) {
	return new TextEncoder().encode(text).length;
}

function truncateToBytes(text, maxBytes) {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) {
		return text;
	}
	return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�+$/u, "");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sourceTemporaryUrl(env) {
	const result = await env.BONOBO.files.source.temporaryUrl({
		expiresInSeconds: TEMPORARY_URL_EXPIRES_SECONDS,
	});
	if (!result || typeof result.url !== "string") {
		throw new Error("Source temporary URL is unavailable");
	}
	return result.url;
}

async function outboundFetchWithRetry(env, args, isRetryableStatus) {
	let response = null;
	for (let attempt = 0; attempt < OUTBOUND_RETRY_ATTEMPTS; attempt += 1) {
		const lastAttempt = attempt === OUTBOUND_RETRY_ATTEMPTS - 1;
		try {
			response = await env.BONOBO.outbound.fetch(args);
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

export async function extractAudioUrl(env, { modalUrl, modalToken, sourceUrl, contentType }) {
	const response = await outboundFetchWithRetry(
		env,
		{
			url: modalUrl,
			method: "POST",
			headers: {
				Authorization: `Bearer ${modalToken}`,
				"Content-Type": "application/json",
			},
			bodyText: JSON.stringify({ sourceUrl, contentType, maxBytes: MODAL_MAX_SOURCE_BYTES }),
			responseType: "text",
		},
		(status) => status >= 500,
	);
	if (!response.ok) {
		if (response.status >= 500) {
			throw new Error(`Modal audio extraction failed (HTTP ${response.status})`);
		}
		throw new Error(`Modal audio extractor rejected the request (HTTP ${response.status})`);
	}

	const payload = parseJson(response.bodyText ?? "", "Modal audio extractor");
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

function multipartTextBody(boundary, fields) {
	const parts = fields.map(
		([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
	);
	return `${parts.join("")}--${boundary}--\r\n`;
}

export async function transcribeWithMistral(env, { apiKey, fileUrl }) {
	const boundary = `bonobo-plugin-${crypto.randomUUID()}`;
	const response = await outboundFetchWithRetry(
		env,
		{
			url: MISTRAL_TRANSCRIPTION_URL,
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			bodyText: multipartTextBody(boundary, [
				["model", MISTRAL_TRANSCRIPTION_MODEL],
				["file_url", fileUrl],
				["diarize", "true"],
				["timestamp_granularities", "segment"],
			]),
			responseType: "text",
		},
		(status) => status === 429 || status >= 500,
	);
	if (!response.ok) {
		if (response.status === 429 || response.status >= 500) {
			throw new Error(`Mistral transcription failed (HTTP ${response.status})`);
		}
		throw new Error(`Mistral rejected the media (HTTP ${response.status})`);
	}

	return parseJson(response.bodyText ?? "", "Mistral transcription");
}

function speakerLabel(speakerId) {
	if (typeof speakerId !== "string" || speakerId.length === 0) {
		return null;
	}
	const numbered = speakerId.match(/^speaker_(\d+)$/u);
	return numbered ? `Speaker ${numbered[1]}` : speakerId;
}

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

export function formatTimestamp(ms) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function mergeSegmentsIntoTurns(segments) {
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

function normalizedTranscriptText(normalized) {
	if (normalized.segments.length === 0) {
		return normalized.text;
	}
	return normalized.segments.map((segment) => `${segment.speaker ?? "Speaker ?"}: ${segment.text}`).join("\n");
}

export async function summarizeTranscript(env, { apiKey, normalized, sourceName }) {
	const response = await outboundFetchWithRetry(
		env,
		{
			url: OPENAI_CHAT_COMPLETIONS_URL,
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			bodyText: JSON.stringify({
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
			responseType: "text",
		},
		(status) => status === 429 || status >= 500,
	);
	if (!response.ok) {
		throw new Error(`OpenAI summary failed (HTTP ${response.status})`);
	}

	const payload = parseJson(response.bodyText ?? "", "OpenAI summary");
	const choices = payload && typeof payload === "object" && Array.isArray(payload.choices) ? payload.choices : [];
	const message = choices[0] && typeof choices[0] === "object" ? choices[0].message : null;
	const content = message && typeof message === "object" ? message.content : null;
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new Error("OpenAI returned no summary text");
	}
	return unwrapMarkdown(content);
}

export default {
	async fetch(request, env) {
		const event = await readEvent(request);
		const source = getSource(event);
		if (!source) {
			return json({ error: "Upload source is missing" }, 400);
		}

		const kind = mediaKind(source.contentType);
		if (!kind) {
			return skipped();
		}

		const mistralApiKey = await requireSecret(env, "MISTRAL_API_KEY");
		const openaiApiKey = await requireSecret(env, "OPENAI_API_KEY");
		const modalUrl = kind === "video" ? await requireSecret(env, "MODAL_MEDIA_AUDIO_URL") : null;
		const modalToken = kind === "video" ? await requireSecret(env, "MODAL_TOKEN") : null;

		const sourceUrl = await sourceTemporaryUrl(env);
		const fileUrl =
			kind === "video"
				? (await extractAudioUrl(env, { modalUrl, modalToken, sourceUrl, contentType: source.contentType })).audioUrl
				: sourceUrl;
		const transcription = await transcribeWithMistral(env, { apiKey: mistralApiKey, fileUrl });
		const normalized = normalizeMistralTranscription(transcription);
		const model =
			transcription && typeof transcription.model === "string" ? transcription.model : MISTRAL_TRANSCRIPTION_MODEL;

		const transcriptPath = `${source.name}.transcript.md`;
		const summaryPath = `${source.name}.summary.md`;
		await env.BONOBO.files.writeMarkdown({
			path: transcriptPath,
			markdown: transcriptMarkdown({ sourceName: source.name, model, normalized }),
			overwrite: "replace",
		});

		const noSpeech = normalized.text.length === 0 && normalized.segments.length === 0;
		const summary = noSpeech
			? NO_SPEECH_BODY
			: await summarizeTranscript(env, { apiKey: openaiApiKey, normalized, sourceName: source.name });
		await env.BONOBO.files.writeMarkdown({
			path: summaryPath,
			markdown: `# Summary — ${source.name}\n\n${summary}`,
			overwrite: "replace",
		});

		return json({ ok: true, files: [transcriptPath, summaryPath] });
	},
};
