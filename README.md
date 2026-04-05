# MMM-AINews

A [MagicMirror²](https://magicmirror.builders/) module that fetches RSS feeds and displays AI-generated summaries using the GitHub Copilot API.

Each configured source produces one paragraph of text, summarized according to per-source instructions.

## Features

- **N sources → N paragraphs** — each RSS feed gets its own AI summary with custom instructions
- **GitHub Copilot API** — uses the same chat completions API as Copilot in VS Code
- **Standalone auth tool** — one-time device flow login, token persists indefinitely
- **Auto-refreshing session tokens** — runs unattended with no manual intervention
- **Staleness indicator** — visual warning when data is old
- **Configurable title** — set via `header` in your MagicMirror config
- **Zero external dependencies** — uses built-in `fetch` and MagicMirror's `feedme` RSS parser

## Prerequisites

- MagicMirror²
- A GitHub account with an active [Copilot subscription](https://github.com/features/copilot)

## Setup

### 1. Authenticate with GitHub Copilot

Run the auth tool once from your MagicMirror root directory:

```bash
node modules/MMM-AINews/tools/copilot-auth.js
```

This will:
1. Show you a URL and a one-time code
2. You visit the URL in a browser and enter the code
3. The OAuth token is saved to `modules/MMM-AINews/credentials/github-oauth.json`

The token persists indefinitely (until revoked on GitHub). You only need to do this once.

### 2. Configure the Module

Add to your `config/config.js`:

```js
{
    module: "MMM-AINews",
    position: "bottom_bar",
    header: "AI News Briefing",
    config: {
        updateInterval: 30 * 60 * 1000, // 30 minutes
        model: "gpt-4.1",               // Copilot model to use
        sources: [
            {
                name: "Israel",
                url: "https://www.ynetnews.com/cmlink/1.7886",
                instructions: "Summarize the top Israel headlines in 1-2 concise sentences. Focus on security and political developments."
            },
            {
                name: "Tech",
                url: "https://feeds.arstechnica.com/arstechnica/technology-lab",
                instructions: "Summarize the most significant technology news in 1-2 concise sentences."
            },
            {
                name: "US News",
                url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
                instructions: "Summarize the top US news in 1-2 sentences. Focus on major political and economic developments."
            }
        ]
    }
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `header` | `"MMM-AINews"` | Module title displayed above the content |
| `updateInterval` | `1800000` (30 min) | How often to refresh summaries (ms) |
| `model` | `"gpt-4.1"` | Copilot model to use for summarization |
| `sources` | `[]` | Array of RSS source objects (see below) |
| `credentialsPath` | `"credentials/github-oauth.json"` | Path to OAuth token file (relative to module dir) |
| `showSourceLabels` | `true` | Show source name labels above each paragraph |
| `showUpdatedAt` | `true` | Show "Updated HH:MM" footer |
| `staleThresholdMs` | `7200000` (2 hr) | Age after which ⚠ staleness warning appears |
| `maxFrameWidth` | `400` | Maximum width of the module in pixels |
| `animationSpeed` | `1000` | DOM update animation speed (ms) |

### Token Lifecycle

| Token | Storage | Lifetime |
|-------|---------|----------|
| OAuth (`gho_...`) | `credentials/github-oauth.json` (gitignored) | Indefinite |
| Session (`tid=...`) | In memory only | ~30 min, auto-refreshed |

The OAuth token is the durable credential. Session tokens are exchanged via `api.github.com/copilot_internal/v2/token` and cached in memory with a 5-minute safety margin before expiry.

## Re-authenticating

If your OAuth token is revoked, re-run the auth tool:

```bash
node modules/MMM-AINews/tools/copilot-auth.js
```

Then restart MagicMirror.

## License

MIT
