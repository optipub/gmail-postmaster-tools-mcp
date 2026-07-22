#!/usr/bin/env node
'use strict';

/*
 * Gmail Postmaster Tools MCP server (stdio transport).
 *
 * Dependency-free MCP over newline-delimited JSON-RPC 2.0. Exposes the Gmail
 * Postmaster Tools API v2 behind a bring-your-own Google OAuth (auth-code +
 * PKCE, 127.0.0.1 loopback) sign-in.
 */

const readline = require('readline');
const auth = require('./auth');
const gpt = require('./gpt');

const SERVER_NAME = 'gmail-postmaster-tools';
const SERVER_VERSION = '1.0.1';
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'gpt_authenticate',
    description:
      'Sign in to Gmail Postmaster Tools. Opens your browser for a Google account login (OAuth 2.0 authorization-code + PKCE over a 127.0.0.1 loopback) using the Google OAuth client you configured, and caches the tokens. Run this once before fetching data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gpt_auth_status',
    description: 'Check whether you are signed in to Gmail Postmaster Tools and when the access token expires.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gpt_sign_out',
    description: 'Delete the cached Google tokens (sign out).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_domains',
    description: 'List the domains registered in your Gmail Postmaster Tools account, with verification state and your permission level. Calls GET /v2/domains.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Optional max number of domains (default 10, max 200).' },
        pageToken: { type: 'string', description: 'Optional page token from a previous call.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_domain',
    description: 'Get metadata for a single registered domain (verification state, permission, timestamps). Calls GET /v2/domains/{domain}.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Fully-qualified domain name, e.g. mail.example.com.' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_compliance_status',
    description: 'Get the sender compliance status for a domain — verdicts for SPF, DKIM, DMARC, alignment, message formatting, DNS records, encryption, user-reported spam rate, and one-click / honored unsubscribe. Calls GET /v2/domains/{domain}/complianceStatus.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Fully-qualified domain name, e.g. example.com.' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_domain_stats',
    description:
      'Query Gmail traffic metrics for a domain over a date range. Metrics include SPAM_RATE, AUTH_SUCCESS_RATE (filter auth_type=spf|dkim|dmarc), TLS_ENCRYPTION_RATE (filter traffic_direction=inbound|outbound), DELIVERY_ERROR_RATE/COUNT (optional filter error_type=...), FEEDBACK_LOOP_SPAM_RATE/ID. Defaults to SPAM_RATE over the last ~7 days, daily. Calls POST /v2/domains/{domain}/domainStats:query.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Fully-qualified domain name, e.g. example.com.' },
        start_date: { type: 'string', description: 'Start date yyyy-MM-dd (inclusive). Defaults to ~8 days ago.' },
        end_date: { type: 'string', description: 'End date yyyy-MM-dd (inclusive). Defaults to yesterday.' },
        granularity: { type: 'string', enum: ['DAILY', 'OVERALL'], description: 'DAILY (per-day) or OVERALL (totals for the period). Default DAILY.' },
        metrics: {
          type: 'array',
          description: 'Metrics to fetch. Each item is either a standard metric name (string) or an object { standardMetric, filter, name }. Metrics like AUTH_SUCCESS_RATE and TLS_ENCRYPTION_RATE require a filter. Defaults to ["SPAM_RATE"].',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  standardMetric: { type: 'string' },
                  filter: { type: 'string' },
                  name: { type: 'string' },
                },
                required: ['standardMetric'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
];

function formatResponse(resp, label) {
  if (resp.status >= 200 && resp.status < 300) {
    let parsed;
    try { parsed = JSON.parse(resp.body); } catch (_) { parsed = null; }
    const payload = parsed !== null ? JSON.stringify(parsed, null, 2) : (resp.body || '(empty body)');
    return `${label}: HTTP ${resp.status}\n\n${payload}`;
  }
  if (resp.status === 404) return `${label}: HTTP 404 Not Found — domain not registered by you, or no data.`;
  if (resp.status === 403) return `${label}: HTTP 403 — access denied. Check the error body below for the reason (e.g. SERVICE_DISABLED = enable the Postmaster Tools API on this project; PERMISSION_DENIED / access not configured = project not on the v2 preview allowlist or wrong project; ACCESS_TOKEN_SCOPE_INSUFFICIENT = re-run gpt_authenticate to widen scope).\n${resp.body || '(empty body)'}`.trim();
  if (resp.status === 400) return `${label}: HTTP 400 Bad Request.\n${resp.body || ''}`.trim();
  return `${label}: HTTP ${resp.status}\n${resp.body || ''}`.trim();
}

function fmtTime(ms) { try { return new Date(ms).toISOString(); } catch (_) { return String(ms); } }

async function callTool(name, args) {
  switch (name) {
    case 'gpt_authenticate': {
      if (!auth.hasCreds()) return auth.SETUP_HELP;
      await auth.interactiveLogin();
      return 'Connected to Gmail Postmaster Tools. You can now query your domains and stats.';
    }
    case 'gpt_auth_status': {
      if (!auth.hasCreds()) return auth.SETUP_HELP;
      const cache = auth.loadCache();
      if (!cache) return 'Not signed in. Run gpt_authenticate to sign in.';
      const silent = await auth.getAccessTokenSilent();
      if (silent.ok) return `Signed in. Access token valid until ${fmtTime(silent.expires_at)} (auto-refresh enabled).`;
      return `Cached session is no longer usable (${silent.reason}${silent.error ? ': ' + silent.error : ''}). Run gpt_authenticate again.`;
    }
    case 'gpt_sign_out':
      return auth.clearCache() ? 'Signed out — cached tokens deleted.' : 'No cached tokens to remove.';
    case 'list_domains':
      return formatResponse(await gpt.listDomains(args), 'Registered domains');
    case 'get_domain':
      return formatResponse(await gpt.getDomain(args), `Domain ${args.domain}`);
    case 'get_compliance_status':
      return formatResponse(await gpt.getComplianceStatus(args), `Compliance status for ${args.domain}`);
    case 'query_domain_stats':
      return formatResponse(await gpt.queryDomainStats(args), `Domain stats for ${args.domain}`);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- JSON-RPC plumbing ---

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function sendResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'ping':
        if (isRequest) sendResult(id, {});
        return;
      case 'tools/list':
        sendResult(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        try {
          const text = await callTool(toolName, toolArgs);
          sendResult(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          sendResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
        return;
      }
      default:
        if (isRequest) sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (e) {
    if (isRequest) sendError(id, -32603, `Internal error: ${e.message}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch (_) { return; }
  if (Array.isArray(msg)) msg.forEach(handleMessage);
  else handleMessage(msg);
});
rl.on('close', () => process.exit(0));

process.stderr.write(`[Gmail Postmaster MCP] ${SERVER_NAME} v${SERVER_VERSION} ready (creds ${auth.hasCreds() ? 'configured' : 'MISSING'}, API ${gpt.API_BASE}).\n`);
