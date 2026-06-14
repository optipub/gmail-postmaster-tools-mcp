'use strict';

/*
 * REST client for the Gmail Postmaster Tools API v2.
 *
 *   GET  /v2/domains                              list registered domains
 *   GET  /v2/domains/{domain}                     domain metadata
 *   GET  /v2/domains/{domain}/complianceStatus    sender compliance verdicts
 *   POST /v2/domains/{domain}/domainStats:query   traffic metrics over a time range
 *
 * Authenticated with a Bearer access token obtained by ./auth.js.
 */

const https = require('https');
const { URL } = require('url');
const auth = require('./auth');

const API_BASE = (process.env.GPT_API_BASE || 'https://gmailpostmastertools.googleapis.com/v2').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = parseInt(process.env.GPT_REQUEST_TIMEOUT_MS || '60000', 10);

const STANDARD_METRICS = [
  'FEEDBACK_LOOP_ID',
  'FEEDBACK_LOOP_SPAM_RATE',
  'SPAM_RATE',
  'AUTH_SUCCESS_RATE',
  'TLS_ENCRYPTION_MESSAGE_COUNT',
  'TLS_ENCRYPTION_RATE',
  'DELIVERY_ERROR_COUNT',
  'DELIVERY_ERROR_RATE',
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9-]{1,63})(\.[a-zA-Z0-9-]{1,63})+$/;

function request(method, urlStr, token, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'gmail-postmaster-mcp/1.0' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS} ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function call(method, pathSuffix, bodyObj) {
  const token = await auth.getAccessToken({ interactive: false });
  const resp = await request(method, API_BASE + pathSuffix, token, bodyObj);
  if (resp.status === 401) {
    const e = new Error('Google rejected the access token (401). Run "gpt_authenticate" to sign in again.');
    e.code = 'NEED_AUTH';
    throw e;
  }
  return resp;
}

function validateDomain(domain) {
  if (!domain || !HOST_RE.test(domain)) {
    throw new Error(`Invalid domain "${domain}". Use a fully-qualified domain name, e.g. mail.example.com.`);
  }
  return domain;
}

function parseDate(s, label) {
  if (!DATE_RE.test(s)) throw new Error(`Invalid ${label} "${s}". Expected yyyy-MM-dd.`);
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
}

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

// --- public methods ---

async function listDomains({ pageSize, pageToken } = {}) {
  const qs = new URLSearchParams();
  if (pageSize) qs.set('pageSize', String(pageSize));
  if (pageToken) qs.set('pageToken', pageToken);
  const q = qs.toString();
  return call('GET', `/domains${q ? '?' + q : ''}`);
}

async function getDomain({ domain }) {
  validateDomain(domain);
  return call('GET', `/domains/${encodeURIComponent(domain)}`);
}

async function getComplianceStatus({ domain }) {
  validateDomain(domain);
  return call('GET', `/domains/${encodeURIComponent(domain)}/complianceStatus`);
}

async function queryDomainStats({ domain, start_date, end_date, granularity, metrics } = {}) {
  validateDomain(domain);

  const end = end_date || isoDaysAgo(1);          // yesterday (today's data is usually incomplete)
  const start = start_date || isoDaysAgo(8);      // ~last 7 days
  const gran = (granularity || 'DAILY').toUpperCase();
  if (!['DAILY', 'OVERALL'].includes(gran)) throw new Error('granularity must be DAILY or OVERALL.');

  // Normalize metrics: accept array of strings or objects {name?, standardMetric, filter?}.
  let input = metrics;
  if (!input || (Array.isArray(input) && input.length === 0)) input = ['SPAM_RATE'];
  if (!Array.isArray(input)) input = [input];
  const metricDefinitions = input.map((m, i) => {
    const std = (typeof m === 'string' ? m : m.standardMetric || '').toUpperCase();
    if (!STANDARD_METRICS.includes(std)) {
      throw new Error(`Unknown metric "${std}". Supported: ${STANDARD_METRICS.join(', ')}.`);
    }
    const def = { name: (typeof m === 'object' && m.name) ? m.name : `${std}_${i}`, baseMetric: { standardMetric: std } };
    if (typeof m === 'object' && m.filter) def.filter = m.filter;
    return def;
  });

  const body = {
    metricDefinitions,
    aggregationGranularity: gran,
    timeQuery: {
      dateRanges: { dateRanges: [{ start: parseDate(start, 'start_date'), end: parseDate(end, 'end_date') }] },
    },
  };
  return call('POST', `/domains/${encodeURIComponent(domain)}/domainStats:query`, body);
}

module.exports = {
  API_BASE,
  STANDARD_METRICS,
  listDomains,
  getDomain,
  getComplianceStatus,
  queryDomainStats,
};
