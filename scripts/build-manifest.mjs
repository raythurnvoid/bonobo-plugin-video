#!/usr/bin/env node
// Syncs bonobo.plugin.json's files[] hashes, package.json, and dist/bonobo.plugin.json.
//
// bonobo.plugin.json at the repository root is the single source of truth. Every
// files[] entry's sha256/bytes is recomputed from the file on disk (paths are
// relative to the repository root, matching how the app fetches them from GitHub
// at publish time), package.json's version is synced from the manifest, and the
// final manifest is byte-copied to dist/bonobo.plugin.json — the only file the
// app fetches at publish time. All edits are surgical string splices so the
// existing formatting of every file is preserved byte-for-byte; when everything
// is already in sync the run writes nothing.
//
// Usage: pnpm build:manifest

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
	console.error(`build-manifest: ${message}`);
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
		console.log(`build-manifest: "${relativePath}" already in sync`);
		return;
	}
	writeFileSync(join(repoRoot, relativePath), updatedText);
	console.log(`build-manifest: updated "${relativePath}"`);
}

const originalManifestText = readText("bonobo.plugin.json");
const manifest = JSON.parse(originalManifestText);
for (const key of ["name", "displayName", "version", "description"]) {
	if (typeof manifest[key] !== "string" || manifest[key] === "") {
		fail(`bonobo.plugin.json is missing "${key}"`);
	}
}
if (!Array.isArray(manifest.files)) {
	fail(`bonobo.plugin.json has no "files" array`);
}

// Manifest: recompute files[] sha256/bytes from the files on disk.
let manifestText = originalManifestText;
for (const file of manifest.files) {
	let fileBytes;
	try {
		fileBytes = readFileSync(join(repoRoot, file.path));
	} catch {
		fail(`Manifest file is missing on disk: "${file.path}"`);
	}
	const sha256 = `sha256:${createHash("sha256").update(fileBytes).digest("hex")}`;
	const anchorPattern = new RegExp(`"path"\\s*:\\s*${escapeRegExp(JSON.stringify(file.path))}`);
	const context = `the files[] entry for "${file.path}" in "bonobo.plugin.json"`;
	manifestText = replaceJsonValue(manifestText, anchorPattern, "sha256", JSON.stringify(sha256), context);
	manifestText = replaceJsonValue(manifestText, anchorPattern, "bytes", String(fileBytes.byteLength), context);
}
writeIfChanged("bonobo.plugin.json", originalManifestText, manifestText);

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

// dist/bonobo.plugin.json: byte-copy of the final root manifest, the file the
// app fetches at publish time. May not exist yet on the first run.
let originalDistManifestText = null;
try {
	originalDistManifestText = readFileSync(join(repoRoot, "dist/bonobo.plugin.json"), "utf8");
} catch {
	// First run: the dist copy does not exist yet.
}
writeIfChanged("dist/bonobo.plugin.json", originalDistManifestText, manifestText);
