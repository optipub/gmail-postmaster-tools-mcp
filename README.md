# Gmail Postmaster Tools MCP

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built with MCPB](https://img.shields.io/badge/built%20with-MCPB-7C3AED.svg)](https://github.com/anthropics/mcpb)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-success.svg)](#why-zero-dependencies)

An [MCP](https://modelcontextprotocol.io) server for the **Gmail Postmaster
Tools API (v2)** — query your domains, sender compliance status, and Gmail
traffic metrics from Claude, Cursor, or any MCP client.

This is a **bring-your-own-credentials** tool for hands-on senders: you supply
your own Google OAuth client, and the server runs the sign-in locally. Nothing
is hosted and no data leaves your machine.

> Want this without setting up a Google Cloud project? That's what
> **[Postmaster+](https://postmasterplus.com)** is for — hosted, multi-provider
> (Gmail + Outlook + more), with verification, history, and alerting.

Built & maintained by the **[Postmaster+](https://postmasterplus.com)** team at **[OptiPub](https://optipub.com)**.

## What you get

- `list_domains` / `get_domain` — your registered domains and their verification state
- `get_compliance_status` — SPF, DKIM, DMARC, alignment, message formatting, DNS records, TLS encryption, user-reported spam rate, and one-click / honored unsubscribe verdicts
- `query_domain_stats` — spam rate, auth success (SPF/DKIM/DMARC), TLS encryption rate, delivery errors, and feedback-loop metrics over any date range
- `gpt_authenticate` / `gpt_auth_status` / `gpt_sign_out`

> Note: Postmaster Tools **v2** covers traffic metrics + compliance. Domain and
> IP *reputation* are not part of v2.

## Prerequisites: create a Google OAuth client (one-time, ~5 min)

You need a Google Cloud OAuth client because Google doesn't offer a shared
public one for this API.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. **APIs & Services → Library** → search **"Gmail Postmaster Tools API"** → **Enable**.
3. **APIs & Services → OAuth consent screen** (redirects to **Google Auth Platform**). If the project has never been configured, click **Get started** and set an **App name** + support email, **Audience = External**, and a contact email. If it's already configured, you'll just see the tabs — skip to the next step.
4. Open the **Audience** tab. If **User type = External**, add your Google address under **Test users → + Add users** and **Save** (leave status as **Testing** — works without app verification, up to 100 users). If **User type = Internal** (a Workspace org project), no test users are needed — org users can sign in directly.
5. Open the **Clients** tab (or **APIs & Services → Credentials**) → **Create client** → application type **Desktop app** → **Create**.
6. Copy the **Client ID** and **Client secret**.

You'll paste those two values into this extension's configuration at install
time. (Make sure the Google account you sign in with is one that has access in
[Gmail Postmaster Tools](https://postmaster.google.com/).)

## Install in Claude / Cowork (the `.mcpb`)

The `.mcpb` is a packaging convenience for Claude Desktop / Cowork only.

1. Download `gmail-postmaster-tools.mcpb` from the [latest release](../../releases/latest).
2. **Settings → Capabilities → install extension**, pick the file.
3. When prompted, paste your **Google OAuth Client ID** and **Client Secret**.
4. Run `gpt_authenticate` once — your browser opens for the Google sign-in.

## Use with other MCP clients (Cursor, VS Code, Windsurf, …)

Underneath, this is a standard **stdio MCP server** — any client that runs local
MCP servers can use it directly, no `.mcpb` required. Clone or download the repo,
then point the client at `server/index.js` and pass your Google credentials as
env vars.

**Cursor** — edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "gmail-postmaster-tools": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-postmaster-tools-mcp/server/index.js"],
      "env": {
        "GPT_CLIENT_ID": "xxxxx.apps.googleusercontent.com",
        "GPT_CLIENT_SECRET": "xxxxx"
      }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`), **Windsurf**, **Claude Desktop** (manual config),
and most other clients use the same `command` + `args` + `env` shape — only the
config file location differs. Other env overrides are listed under
[Configuration](#configuration-env-overrides).

The first tool call (or `gpt_authenticate`) opens your browser for the Google
sign-in; the `127.0.0.1` loopback works on any local desktop client.

> **Remote-only clients (e.g. Perplexity, ChatGPT connectors):** these accept
> only a remote HTTPS MCP server URL, not a local command, so this stdio build
> can't be added directly. That would require hosting it — which is what
> [Postmaster+](https://postmasterplus.com) provides.

## Usage examples

- "Sign me in to Gmail Postmaster Tools" → `gpt_authenticate`
- "List my Postmaster domains" → `list_domains`
- "Is example.com compliant with Gmail's sender rules?" → `get_compliance_status { domain: "example.com" }`
- "Spam rate for example.com over the last 30 days" → `query_domain_stats { domain: "example.com", start_date: "...", end_date: "...", metrics: ["SPAM_RATE"] }`
- "DKIM auth success for example.com" → `query_domain_stats { domain: "example.com", metrics: [{ "standardMetric": "AUTH_SUCCESS_RATE", "filter": "auth_type=\"dkim\"" }] }`

Some metrics require a filter: `AUTH_SUCCESS_RATE` (`auth_type=spf|dkim|dmarc`),
`TLS_ENCRYPTION_RATE` (`traffic_direction=inbound|outbound`),
`DELIVERY_ERROR_RATE` (optional `error_type=...`). `SPAM_RATE` needs none.

## How authentication works

OAuth 2.0 authorization-code + PKCE, over a `http://127.0.0.1:<dynamic-port>`
loopback redirect (Google's recommended flow for desktop apps). On sign-in the
server starts a short-lived listener on `127.0.0.1`, opens your browser, receives
the code, and exchanges it (with your client secret + PKCE verifier) for tokens.

Google requires a client secret even for desktop apps, which is why both values
are needed. Tokens are stored only on your machine at
`~/.gmail-postmaster-mcp/tokens.json` (`0600`) and are git-ignored.

**Scopes:** by default the server requests
`postmaster.traffic.readonly` (metrics + compliance) and `postmaster.domain`
(list/get domains). Override with the `GPT_SCOPE` env var if you want to narrow
it (e.g. traffic-only, dropping `list_domains`/`get_domain`).

## Configuration (env overrides)

| Variable | Purpose | Default |
| --- | --- | --- |
| `GPT_CLIENT_ID` | Google OAuth client ID (required) | — |
| `GPT_CLIENT_SECRET` | Google OAuth client secret (required) | — |
| `GPT_SCOPE` | Space-separated OAuth scopes | traffic.readonly + domain |
| `GPT_API_BASE` | API base URL | `https://gmailpostmastertools.googleapis.com/v2` |
| `GPT_TOKEN_DIR` | Token cache directory | `~/.gmail-postmaster-mcp` |
| `GPT_LOGIN_TIMEOUT_MS` | Sign-in wait | `180000` |
| `GPT_REQUEST_TIMEOUT_MS` | Per-request timeout | `60000` |

## Build

```bash
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . gmail-postmaster-tools.mcpb
```

Pushing a `vX.Y.Z` tag triggers CI to pack, attach the `.mcpb` to a GitHub
Release, and publish to the MCP Registry.

## Why zero dependencies

Only Node.js built-ins (`http`, `https`, `crypto`, `readline`) — tiny bundle, no
supply-chain risk, nothing to `npm install`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © OptiPub

---

*Not affiliated with or endorsed by Google. "Gmail", "Google", and "Postmaster
Tools" are trademarks of Google LLC.*
