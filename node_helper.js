/**
 * MMM-AINews — Node Helper
 *
 * Backend worker that:
 * 1. Manages Copilot session tokens (exchange + refresh)
 * 2. Fetches and parses RSS feeds
 * 3. Summarizes feed items via Copilot chat completions
 * 4. Sends results to the frontend via socket notifications
 */

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const NodeHelper = require("node_helper");
const Log = require("logger");

// Copilot API constants (verified from OpenClaw source)
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_API_BASE = "https://api.individual.githubcopilot.com";
const IDE_HEADERS = {
  "Editor-Version": "vscode/1.96.2",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "X-Github-Api-Version": "2025-04-01"
};
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry

/**
 * HTTPS/HTTP request helper. Returns { statusCode, body } for text.
 * Works on Node 12+.
 *
 * @param {string} url Request URL.
 * @param {object} options Request options.
 * @param {string} [options.method] HTTP method.
 * @param {Object<string, string>} [options.headers] Request headers.
 * @param {number} [options._redirects] Redirect counter.
 * @param {string|Buffer} [postBody] Optional request body for POST/PUT requests.
 * @returns {Promise<{ statusCode: number, body: string }>} Resolves with HTTP status and response body.
 */
function httpRequest(url, options, postBody) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {}
    };
    const req = mod.request(opts, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        if ((options._redirects || 0) >= 5) {
          reject(new Error("Too many redirects"));
          return;
        }
        httpRequest(
          res.headers.location,
          { ...options, _redirects: (options._redirects || 0) + 1 },
          postBody
        )
          .then(resolve)
          .catch(reject);
        return;
      }

      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on("error", reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

/**
 * Send an HTTP request and parse the response body as JSON.
 *
 * @param {string} url Request URL.
 * @param {object} options Request options.
 * @param {string} [options.method] HTTP method.
 * @param {Object<string, string>} [options.headers] Request headers.
 * @param {number} [options._redirects] Redirect counter.
 * @param {string|Buffer} [postBody] Optional request body for POST/PUT requests.
 * @returns {Promise<any>} Parsed JSON response.
 */
async function httpJson(url, options, postBody) {
  const headers = { ...options.headers, Accept: "application/json" };
  const res = await httpRequest(url, { ...options, headers }, postBody);
  if (res.statusCode >= 400) {
    throw new Error(`HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
  }
  return JSON.parse(res.body);
}

/**
 * Send an HTTP request and return the response body as text.
 *
 * @param {string} url Request URL.
 * @param {object} options Request options.
 * @param {string} [options.method] HTTP method.
 * @param {Object<string, string>} [options.headers] Request headers.
 * @param {number} [options._redirects] Redirect counter.
 * @returns {Promise<string>} Response body text.
 */
async function httpText(url, options) {
  const res = await httpRequest(url, options);
  if (res.statusCode >= 400) {
    throw new Error(`HTTP ${res.statusCode}`);
  }
  return res.body;
}

module.exports = NodeHelper.create({
  start: function () {
    Log.log(`Starting node helper for: ${this.name}`);
    this.oauthToken = null;
    this.sessionToken = null;
    this.sessionExpiresAt = 0;
    this.apiBaseUrl = DEFAULT_API_BASE;
    this.timer = null;
  },

  stop: function () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "START_FETCHING") {
      this.config = payload;
      this.loadOAuthToken();
      if (this.oauthToken) {
        this.fetchAndSummarize();
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
          this.fetchAndSummarize();
        }, this.config.updateInterval || 30 * 60 * 1000);
      }
    }
  },

  /**
   * Load the OAuth token from credentials file.
   */
  loadOAuthToken: function () {
    const credPath = path.resolve(
      __dirname,
      "credentials",
      "github-oauth.json"
    );
    try {
      const data = JSON.parse(fs.readFileSync(credPath, "utf8"));
      if (!data.token) {
        throw new Error("No token field in credentials file");
      }
      this.oauthToken = data.token;
      Log.log("MMM-AINews: OAuth token loaded");
    } catch (err) {
      Log.error(
        `MMM-AINews: Failed to load OAuth token from ${credPath}: ${err.message}`
      );
      Log.error(
        "MMM-AINews: Run 'node modules/MMM-AINews/tools/copilot-auth.js' to authenticate."
      );
      this.sendSocketNotification("AINEWS_ERROR", {
        error:
          "No credentials. Run: node modules/MMM-AINews/tools/copilot-auth.js"
      });
    }
  },

  /**
   * Exchange OAuth token for a Copilot session token.
   * Caches in memory; refreshes when within safety margin of expiry.
   */
  ensureSessionToken: async function () {
    const now = Date.now();
    if (
      this.sessionToken &&
      this.sessionExpiresAt - now > TOKEN_SAFETY_MARGIN_MS
    ) {
      return true;
    }

    Log.log("MMM-AINews: Exchanging OAuth token for Copilot session token...");

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const json = await httpJson(COPILOT_TOKEN_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.oauthToken}`,
            ...IDE_HEADERS
          }
        });
        if (!json.token) {
          throw new Error("Response missing token field");
        }

        this.sessionToken = json.token;
        // expires_at is in seconds; convert defensively
        const expiresAt = json.expires_at;
        this.sessionExpiresAt =
          expiresAt < 100_000_000_000 ? expiresAt * 1000 : expiresAt;

        // Derive API base URL from proxy-ep in token
        this.apiBaseUrl = this.deriveApiBaseUrl(json.token);

        Log.log(
          `MMM-AINews: Session token acquired (expires in ${Math.round(
            (this.sessionExpiresAt - Date.now()) / 60000
          )}m), API: ${this.apiBaseUrl}`
        );
        return true;
      } catch (err) {
        Log.warn(
          `MMM-AINews: Token exchange attempt ${attempt}/3 failed: ${err.message}`
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }

    Log.error("MMM-AINews: All token exchange attempts failed");
    return false;
  },

  /**
   * Derive API base URL from session token's proxy-ep field.
   * Converts proxy.* to api.* (matching OpenClaw's behavior).
   *
   * @param {string} token Session token cookie string.
   * @returns {string} Derived API base URL.
   */
  deriveApiBaseUrl: function (token) {
    const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
    if (!match || !match[1]) return DEFAULT_API_BASE;
    const proxyEp = match[1].trim();
    try {
      const urlText = /^https?:\/\//i.test(proxyEp)
        ? proxyEp
        : `https://${proxyEp}`;
      const url = new URL(urlText);
      const host = url.hostname.toLowerCase().replace(/^proxy\./i, "api.");
      return `https://${host}`;
    } catch {
      return DEFAULT_API_BASE;
    }
  },

  /**
   * Fetch a single RSS feed URL and return parsed items.
   *
   * @param {string} url Feed URL to fetch.
   * @returns {Promise<object[]>} Parsed feed items.
   */
  fetchRSS: async function (url) {
    const FeedMe = require("feedme");

    try {
      const xml = await httpText(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MMM-AINews/1.0)" }
      });

      const items = await new Promise((resolve, reject) => {
        const parser = new FeedMe(true);
        const parsed = [];

        parser.on("item", (item) => {
          parsed.push({
            title: item.title || "",
            description: (item.description || item.summary || "")
              .replace(/<[^>]*>/g, "")
              .trim(),
            link: item.link || item.url || "",
            pubDate: item.pubdate || item.published || item.date || ""
          });
        });

        parser.on("end", () => resolve(parsed));
        parser.on("error", (err) => reject(err));

        try {
          parser.write(xml);
          parser.end();
        } catch (err) {
          reject(err);
        }
      });

      return items;
    } catch (err) {
      Log.warn(
        `MMM-AINews: Failed to fetch/parse RSS from ${url}: ${err.message}`
      );
      return [];
    }
  },

  /**
   * Fetch all RSS feeds for a source, merge items, and deduplicate by title.
   *
   * @param {object} source Source configuration.
   * @param {string[]} source.urls Array of feed URLs.
   * @returns {Promise<object[]>} Merged and deduplicated feed items.
   */
  fetchAllFeeds: async function (source) {
    const urls = source.urls || [];
    if (urls.length === 0) {
      Log.warn(`MMM-AINews: No URLs configured for "${source.name}"`);
      return [];
    }

    const feedResults = await Promise.all(
      urls.map((url) => this.fetchRSS(url))
    );

    // Merge all items and deduplicate by normalized title
    const seen = new Set();
    const merged = [];
    for (const items of feedResults) {
      for (const item of items) {
        const key = item.title.toLowerCase().trim();
        if (key && !seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
    }

    Log.log(
      `MMM-AINews: "${source.name}" — ${urls.length} feed(s), ${merged.length} unique items`
    );
    return merged;
  },

  /**
   * Call Copilot chat completions to summarize items for one source.
   *
   * @param {object} source Source configuration.
   * @param {string} source.name Source display name.
   * @param {number} [source.maxItems] Maximum number of items to summarize.
   * @param {string} [source.instructions] Summarization instructions.
   * @param {object[]} items Feed items to summarize.
   * @returns {Promise<{ name: string, summary: string, error: string|null }>} Source summary result.
   */
  summarizeSource: async function (source, items) {
    if (!items || items.length === 0) {
      return { name: source.name, summary: "", error: null };
    }

    const maxItems = source.maxItems || 100;
    const truncated = items.slice(0, maxItems);
    const headlines = truncated
      .map((it, i) => {
        const desc = it.description
          ? ` — ${it.description.substring(0, 200)}`
          : "";
        return `${i + 1}. ${it.title}${desc}`;
      })
      .join("\n");

    const systemPrompt =
      "You are a concise news summarizer for a smart mirror display. " +
      "Produce only the requested paragraph(s). No headings, no bullet points, no markdown. " +
      "English only. Be factual and concise.";

    const userPrompt =
      `Here are the latest headlines from "${source.name}":\n\n` +
      `${headlines}\n\n` +
      `Instructions: ${source.instructions}`;

    try {
      const postBody = JSON.stringify({
        model: this.config.model || "gpt-5-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 300,
        temperature: 0.3
      });

      const json = await httpJson(
        `${this.apiBaseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.sessionToken}`,
            "Editor-Version": IDE_HEADERS["Editor-Version"],
            "User-Agent": IDE_HEADERS["User-Agent"],
            "Openai-Intent": "conversation-edits",
            "X-Initiator": "user"
          }
        },
        postBody
      );

      const content =
        json.choices && json.choices[0] && json.choices[0].message
          ? json.choices[0].message.content.trim()
          : "";
      return { name: source.name, summary: content, error: null };
    } catch (err) {
      Log.warn(
        `MMM-AINews: Summarization failed for "${source.name}": ${err.message}`
      );
      return { name: source.name, summary: "", error: err.message };
    }
  },

  /**
   * Main fetch + summarize pipeline.
   */
  fetchAndSummarize: async function () {
    if (!this.oauthToken) return;

    const tokenOk = await this.ensureSessionToken();
    if (!tokenOk) {
      this.sendSocketNotification("AINEWS_ERROR", {
        error: "Failed to acquire Copilot session token"
      });
      return;
    }

    const sources = this.config.sources || [];
    if (sources.length === 0) {
      Log.warn("MMM-AINews: No sources configured");
      return;
    }

    Log.log(`MMM-AINews: Fetching ${sources.length} source(s)...`);

    const results = [];
    for (const source of sources) {
      const items = await this.fetchAllFeeds(source);
      const result = await this.summarizeSource(source, items);
      results.push(result);
    }

    const updatedAt = new Date().toISOString();
    Log.log(
      `MMM-AINews: Updated at ${updatedAt} — ${
        results.filter((r) => r.summary).length
      }/${results.length} sources summarized`
    );

    this.sendSocketNotification("AINEWS_DATA", {
      results,
      updatedAt
    });
  }
});
