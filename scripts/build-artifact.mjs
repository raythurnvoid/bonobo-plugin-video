#!/usr/bin/env node
// Syncs dist/bonobo.artifact.json and package.json from bonobo.plugin.json.
//
// bonobo.plugin.json is the single source of truth for name/displayName/version.
// The artifact's plugin.{name,displayName,version} block is synced from it, every
// files[] entry's sha256/bytes is recomputed from the file on disk (paths are
// relative to the repository root, matching how the app fetches them from GitHub
// at publish time), and package.json's version is synced too. All edits are
// surgical string splices so the existing formatting of every file is preserved
// byte-for-byte; when everything is already in sync the run writes nothing.
//
// Usage: pnpm build:artifact

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
	console.error(`build-artifact: ${message}`);
	process.exit(1);
}

function readText(relativePath) {
	try {
		return readFileSync(join(repoRoot, relativePath), "utf8");
	} catch {
		fail(`Cannot read "${relativePath}"`);
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces the raw JSON value (string or number) of the first `"key": <value>`
// found inside the object that starts at the first match of anchorPattern and
// ends at the next "}". Only the value bytes change; everything else is kept.
function replaceJsonValue(text, anchorPattern, key, rawValue, context) {
	const anchorMatch = anchorPattern.exec(text);
	if (!anchorMatch) {
		fail(`Cannot find ${context}`);
	}
	const objectEnd = text.indexOf("}", anchorMatch.index) + 1;
	const valuePattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d+)`);
	const valueMatch = valuePattern.exec(text.slice(anchorMatch.index, objectEnd));
	if (!valueMatch) {
		fail(`Cannot find "${key}" in ${context}`);
	}
	const valueStart = anchorMatch.index + valueMatch.index + valueMatch[1].length;
	return text.slice(0, valueStart) + rawValue + text.slice(valueStart + valueMatch[2].length);
}

function writeIfChanged(relativePath, originalText, updatedText) {
	if (updatedText === originalText) {
		console.log(`build-artifact: "${relativePath}" already in sync`);
		return;
	}
	writeFileSync(join(repoRoot, relativePath), updatedText);
	console.log(`build-artifact: updated "${relativePath}"`);
}

const manifest = JSON.parse(readText("bonobo.plugin.json"));
for (const key of ["name", "displayName", "version", "artifact"]) {
	if (typeof manifest[key] !== "string" || manifest[key] === "") {
		fail(`bonobo.plugin.json is missing "${key}"`);
	}
}

// Artifact: sync plugin.{name,displayName,version}, recompute files[] sha256/bytes.
const artifactPath = manifest.artifact;
const originalArtifactText = readText(artifactPath);
const artifact = JSON.parse(originalArtifactText);
if (!Array.isArray(artifact.files)) {
	fail(`"${artifactPath}" has no "files" array`);
}

let artifactText = originalArtifactText;
for (const key of ["name", "displayName", "version"]) {
	artifactText = replaceJsonValue(
		artifactText,
		/"plugin"\s*:\s*\{/,
		key,
		JSON.stringify(manifest[key]),
		`the "plugin" block of "${artifactPath}"`,
	);
}
for (const file of artifact.files) {
	let fileBytes;
	try {
		fileBytes = readFileSync(join(repoRoot, file.path));
	} catch {
		fail(`Artifact file is missing on disk: "${file.path}"`);
	}
	const sha256 = `sha256:${createHash("sha256").update(fileBytes).digest("hex")}`;
	const anchorPattern = new RegExp(`"path"\\s*:\\s*${escapeRegExp(JSON.stringify(file.path))}`);
	const context = `the files[] entry for "${file.path}" in "${artifactPath}"`;
	artifactText = replaceJsonValue(artifactText, anchorPattern, "sha256", JSON.stringify(sha256), context);
	artifactText = replaceJsonValue(artifactText, anchorPattern, "bytes", String(fileBytes.byteLength), context);
}
writeIfChanged(artifactPath, originalArtifactText, artifactText);

// package.json: sync the top-level version.
const originalPackageJsonText = readText("package.json");
const packageJsonText = replaceJsonValue(
	originalPackageJsonText,
	/^\{/,
	"version",
	JSON.stringify(manifest.version),
	'the top-level object of "package.json"',
);
writeIfChanged("package.json", originalPackageJsonText, packageJsonText);
