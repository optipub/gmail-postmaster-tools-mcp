'use strict';

/*
 * OAuth 2.0 Authorization Code + PKCE flow for Google / Gmail Postmaster Tools.
 *
 * Bring-your-own credentials: the user creates a Google Cloud OAuth client of
 * type "Desktop app" and supplies its Client ID and Client Secret (Google
 * requires a secret even for desktop apps; PKCE alone is not sufficient).
 * Sign-in uses a loopback (http://127.0.0.1:<dynamic-port>) redirect. Tokens
 * (access + refresh) are cached on disk and refreshed silently.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL, URLSearchParams } = require('url');

const CLIENT_ID = (process.env.GPT_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.GPT_CLIENT_SECRET || '').trim();

const AUTHORIZE_URL = process.env.GPT_AUTHORIZE_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GPT_TOKEN_URL || 'https://oauth2.googleapis.com/token';

// Default scopes cover all read tools: traffic metrics + compliance
// (postmaster.traffic.readonly) and domain list/get (postmaster.domain).
const SCOPE = process.env.GPT_SCOPE
  || 'https://www.googleapis.com/auth/postmaster.traffic.readonly https://www.googleapis.com/auth/postmaster.domain';

const TOKEN_DIR = (process.env.GPT_TOKEN_DIR && process.env.GPT_TOKEN_DIR.trim())
  ? process.env.GPT_TOKEN_DIR.trim()
  : path.join(os.homedir(), '.gmail-postmaster-mcp');
const TOKEN_PATH = path.join(TOKEN_DIR, 'tokens.json');

const LOGIN_TIMEOUT_MS = parseInt(process.env.GPT_LOGIN_TIMEOUT_MS || '180000', 10);

const SETUP_HELP =
  'Google OAuth credentials are not configured. Create an OAuth client of type ' +
  '"Desktop app" in Google Cloud Console (APIs & Services > Credentials), enable ' +
  'the "Gmail Postmaster Tools API", then set the Client ID and Client Secret in ' +
  'this extension\'s configuration. See the README for step-by-step instructions.';

function requireCreds() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    const e = new Error(SETUP_HELP);
    e.code = 'NO_CREDS';
    throw e;
  }
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch (_) { return null; }
}

function saveCache(obj) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (_) {}
}

function clearCache() {
  try { fs.unlinkSync(TOKEN_PATH); return true; } catch (_) { return false; }
}

function postForm(urlStr, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const u = new URL(urlStr);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(`Token endpoint HTTP ${res.statusCode}: ${json.error || ''} ${json.error_description || data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function storeTokenResponse(tok, prev) {
  const now = Date.now();
  const rec = {
    access_token: tok.access_token,
    expires_at: now + ((tok.expires_in || 3600) * 1000),
    // Google only returns refresh_token on the first consent; keep the old one otherwise.
    refresh_token: tok.refresh_token || (prev && prev.refresh_token) || null,
    scope: tok.scope || SCOPE,
    obtained_at: now,
  };
  saveCache(rec);
  return rec;
}

function htmlPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f5f7;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 16px rgba(0,0,0,.12);padding:36px 44px;max-width:460px;text-align:center}
h1{font-size:20px;margin:0 0 12px;color:#1a73e8}p{font-size:14px;color:#333;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      // Avoid `cmd /c start` — it truncates URLs at `&`.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        stdio: 'ignore',
        detached: true,
      }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (_) { /* URL is printed to stderr as a fallback */ }
}

function interactiveLogin() {
  requireCreds();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    let redirectUri;
    let settled = false;
    const server = http.createServer();

    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
      fn();
    };

    const timer = setTimeout(() => {
      done(() => reject(new Error(`Sign-in timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s. Run gpt_authenticate again.`)));
    }, LOGIN_TIMEOUT_MS);

    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const retState = u.searchParams.get('state');

      if (!code && !err) { res.writeHead(404); res.end('Not found'); return; }
      const reply = (body) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); };

      if (err) {
        reply(htmlPage('Sign-in failed', String(err)));
        done(() => reject(new Error(`Authorization error: ${err}`)));
        return;
      }
      if (retState !== state) {
        reply(htmlPage('Sign-in failed', 'State value did not match (possible CSRF). Please try again.'));
        done(() => reject(new Error('OAuth state mismatch.')));
        return;
      }

      postForm(TOKEN_URL, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: verifier,
      }).then((tok) => {
        const rec = storeTokenResponse(tok, loadCache());
        reply(htmlPage('Connected to Gmail Postmaster Tools', 'You\'re authenticated. You can close this tab and return to your assistant.'));
        done(() => resolve(rec));
      }).catch((e) => {
        reply(htmlPage('Token exchange failed', e.message));
        done(() => reject(e));
      });
    });

    server.on('error', (e) => done(() => reject(e)));

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = `${AUTHORIZE_URL}?` + new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',     // request a refresh token
        prompt: 'consent',          // ensure refresh token is returned
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      process.stderr.write(`\n[Gmail Postmaster MCP] Opening your browser to sign in. If it does not open, paste this URL:\n${authUrl}\n\n`);
      openBrowser(authUrl);
    });
  });
}

async function getAccessTokenSilent() {
  const cache = loadCache();
  if (!cache) return { ok: false, reason: 'no_cache' };
  if (cache.access_token && Date.now() < cache.expires_at - 60000) {
    return { ok: true, token: cache.access_token, expires_at: cache.expires_at };
  }
  if (cache.refresh_token) {
    try {
      requireCreds();
      const tok = await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: cache.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
      const rec = storeTokenResponse(tok, cache);
      return { ok: true, token: rec.access_token, expires_at: rec.expires_at };
    } catch (e) {
      return { ok: false, reason: 'refresh_failed', error: e.message };
    }
  }
  return { ok: false, reason: 'expired_no_refresh' };
}

async function getAccessToken({ interactive = false } = {}) {
  const silent = await getAccessTokenSilent();
  if (silent.ok) return silent.token;
  if (!interactive) {
    const e = new Error('Not signed in to Gmail Postmaster Tools. Run the "gpt_authenticate" tool first.');
    e.code = 'NEED_AUTH';
    throw e;
  }
  const rec = await interactiveLogin();
  return rec.access_token;
}

module.exports = {
  hasCreds: () => Boolean(CLIENT_ID && CLIENT_SECRET),
  SCOPE,
  TOKEN_PATH,
  SETUP_HELP,
  interactiveLogin,
  getAccessToken,
  getAccessTokenSilent,
  loadCache,
  clearCache,
};
