# Contributing

Thanks for your interest in improving the Gmail Postmaster Tools MCP!

## Project layout

```
manifest.json          # MCPB manifest (tools, runtime, user_config)
server/
  index.js             # MCP stdio server + tool definitions/dispatch
  auth.js              # Google OAuth (auth-code + PKCE, 127.0.0.1 loopback), token cache
  gpt.js               # Gmail Postmaster Tools API v2 REST client
.github/workflows/     # CI: pack + attach .mcpb + publish to MCP Registry on tags
```

The runtime has **zero dependencies** — only Node.js built-ins (`http`, `https`,
`crypto`, `readline`). Please keep it that way unless there's a strong reason.

## Local development

Requires Node 18+. Provide your own Google OAuth client (see README) via env vars:

```bash
export GPT_CLIENT_ID="...apps.googleusercontent.com"
export GPT_CLIENT_SECRET="..."

# Smoke-test the protocol over stdio (no sign-in needed for list/initialize)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | GPT_TOKEN_DIR=$(mktemp -d) node server/index.js
```

## Building the bundle

```bash
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . gmail-postmaster-tools.mcpb
```

## Releasing

Bump `version` in `manifest.json` and `server/package.json`, commit, then tag:

```bash
git tag v1.0.1
git push origin v1.0.1
```

CI validates, packs, attaches the `.mcpb` to the release, and publishes to the
MCP Registry (hash computed in CI; OIDC auth).

## Guidelines

- Never commit tokens, secrets, or anything from `~/.gmail-postmaster-mcp/`.
- Keep tool names/descriptions clear — they're what the model reads.
- Open an issue before large changes.
