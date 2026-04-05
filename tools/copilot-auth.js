#!/usr/bin/env node
/**
 * copilot-auth.js — Standalone CLI tool for GitHub Copilot OAuth device flow.
 *
 * Run once to authenticate:
 *   node modules/MMM-AINews/tools/copilot-auth.js
 *
 * Stores the OAuth token in modules/MMM-AINews/credentials/github-oauth.json.
 * The token persists indefinitely until revoked on GitHub.
 *
 * Auth flow verified from OpenClaw source:
 *   https://github.com/openclaw/openclaw/blob/main/extensions/github-copilot/login.ts
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const https = require("https");
const querystring = require("querystring");

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const CREDENTIALS_DIR = path.join(__dirname, "..", "credentials");
const TOKEN_PATH = path.join(CREDENTIALS_DIR, "github-oauth.json");

/**
 * Simple HTTPS POST/GET that returns parsed JSON. Works on Node 12+.
 */
function httpsRequest(url, options, body) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const opts = {
			hostname: parsed.hostname,
			path: parsed.pathname + parsed.search,
			method: options.method || "GET",
			headers: options.headers || {}
		};
		const req = https.request(opts, (res) => {
			let data = "";
			res.on("data", (chunk) => { data += chunk; });
			res.on("end", () => {
				if (res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
					return;
				}
				try { resolve(JSON.parse(data)); }
				catch { reject(new Error(`Invalid JSON: ${data.substring(0, 200)}`)); }
			});
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

async function requestDeviceCode() {
	const body = querystring.stringify({
		client_id: CLIENT_ID,
		scope: "read:user"
	});

	const json = await httpsRequest(DEVICE_CODE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded"
		}
	}, body);
	if (!json.device_code || !json.user_code || !json.verification_uri) {
		throw new Error("GitHub device code response missing required fields");
	}
	return json;
}

async function pollForAccessToken(deviceCode, intervalMs, expiresAt) {
	const body = querystring.stringify({
		client_id: CLIENT_ID,
		device_code: deviceCode,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code"
	});

	while (Date.now() < expiresAt) {
		const json = await httpsRequest(ACCESS_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded"
			}
		}, body);

		if (json.access_token) {
			return json.access_token;
		}

		const err = json.error || "unknown";
		if (err === "authorization_pending") {
			await new Promise((r) => setTimeout(r, intervalMs));
			continue;
		}
		if (err === "slow_down") {
			await new Promise((r) => setTimeout(r, intervalMs + 2000));
			continue;
		}
		if (err === "expired_token") {
			throw new Error("Device code expired. Please run this tool again.");
		}
		if (err === "access_denied") {
			throw new Error("Authorization was cancelled by user.");
		}
		throw new Error(`GitHub device flow error: ${err}`);
	}

	throw new Error("Device code expired. Please run this tool again.");
}

async function main() {
	console.log("╔══════════════════════════════════════════╗");
	console.log("║   MMM-AINews — GitHub Copilot Login      ║");
	console.log("╚══════════════════════════════════════════╝");
	console.log();

	// Check for existing token
	if (fs.existsSync(TOKEN_PATH)) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise((resolve) => {
			rl.question("Existing credentials found. Overwrite? (y/N) ", resolve);
		});
		rl.close();
		if (answer.toLowerCase() !== "y") {
			console.log("Aborted.");
			return;
		}
	}

	console.log("Requesting device code from GitHub...");
	const device = await requestDeviceCode();

	console.log();
	console.log("┌──────────────────────────────────────────┐");
	console.log(`│  Visit:  ${device.verification_uri.padEnd(31)}│`);
	console.log(`│  Code:   ${device.user_code.padEnd(31)}│`);
	console.log("└──────────────────────────────────────────┘");
	console.log();
	console.log("Waiting for authorization...");

	const expiresAt = Date.now() + device.expires_in * 1000;
	const intervalMs = Math.max(1000, (device.interval || 5) * 1000);

	const accessToken = await pollForAccessToken(device.device_code, intervalMs, expiresAt);

	// Store the token
	fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
	const payload = {
		token: accessToken,
		createdAt: new Date().toISOString()
	};
	fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2) + "\n");

	console.log();
	console.log(`✓ Token saved to ${path.relative(process.cwd(), TOKEN_PATH)}`);
	console.log("  You can now start MagicMirror with the MMM-AINews module.");
}

main().catch((err) => {
	console.error(`\n✗ Error: ${err.message}`);
	process.exit(1);
});
