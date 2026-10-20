#!/usr/bin/env node
/**
 * Kibo Insider ID -> Billing address lookup
 *
 * Reads a CSV with an "Insider ID" column, looks each ID up in Kibo
 * (CustomerAccount.externalId), and writes the Billing contact fields to CSV.
 *
 * Usage:   node kibo-insider-lookup.js input.csv [output.csv]
 * Needs:   Node 18+, `npm install dotenv`, and a .env file (see .env.example)
 */
require('dotenv').config();
const fs = require('fs');

const {
  KIBO_AUTH_URL = 'https://home.mozu.com/api/platform/applications/authtickets/oauth',
  KIBO_API_HOST,              // e.g. https://t12345.mozu.com  (no trailing slash)
  KIBO_CLIENT_ID,
  KIBO_CLIENT_SECRET,
  KIBO_TENANT_ID,
  KIBO_SITE_ID,
  BATCH_SIZE = '25',          // IDs per request (OR'd filter). Set to 1 if your tenant rejects OR filters.
  CONCURRENCY = '4',
  ID_COLUMN = 'Insider ID',
} = process.env;

// Normalize host: add https:// if missing, drop trailing slashes and a trailing /api
const API_HOST = (() => {
  let h = (KIBO_API_HOST || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (h && !/^https?:\/\//i.test(h)) h = 'https://' + h;
  return h;
})();

// Kibo wants bare numbers in x-vol-tenant / x-vol-site ("42004", not "t42004").
// Strip any letters/quotes/spaces; fall back to the tNNNNN in the host name for tenant.
const digits = v => ((v || '').match(/\d+/) || [''])[0];
const TENANT_ID = digits(KIBO_TENANT_ID) || digits((API_HOST.match(/\/\/t(\d+)/) || [])[1]);
const SITE_ID = digits(KIBO_SITE_ID);

const OUTPUT_COLUMNS = [
  'Insider ID', 'firstName', 'lastNameOrSurname', 'address1', 'address2',
  'cityOrTown', 'stateOrProvince', 'postalOrZipCode', 'customerNumber', 'phoneNumber',
];

// ---------- CSV helpers ----------
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------- Kibo ----------
let token = null; let tokenExpires = 0;
async function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const res = await fetch(KIBO_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: KIBO_CLIENT_ID, client_secret: KIBO_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Auth failed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  token = j.access_token;
  tokenExpires = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}

async function kiboGet(path, attempt = 1) {
  const res = await fetch(`${API_HOST}${path}`, {
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'x-vol-tenant': TENANT_ID,
      ...(SITE_ID ? { 'x-vol-site': SITE_ID } : {}),
      Accept: 'application/json',
    },
  });
  if (res.status === 401 && attempt === 1) { token = null; return kiboGet(path, 2); }
  if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    return kiboGet(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function findAccounts(ids) {
  const filter = ids.map(id => `externalId eq '${id.replace(/'/g, "''")}'`).join(' or ');
  const qs = new URLSearchParams({ filter, pageSize: String(Math.max(ids.length * 2, 20)) });
  const j = await kiboGet(`/api/commerce/customer/accounts?${qs}`);
  return j.items || [];
}

async function billingContact(account) {
  let contacts = account.contacts;
  if (!Array.isArray(contacts)) {
    const j = await kiboGet(`/api/commerce/customer/accounts/${account.id}/contacts?pageSize=50`);
    contacts = j.items || [];
  }
  const billing = contacts.filter(c => (c.types || []).some(t => (t.name || '').toLowerCase() === 'billing'));
  const best = billing.find(c => c.types.some(t => t.name.toLowerCase() === 'billing' && t.isPrimary)) || billing[0] || null;
  return { billing: best, contacts };
}

// simple concurrency limiter
async function runPool(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  }));
}

// ---------- main ----------
(async () => {
  const [inPath, outPath = 'insider_billing_addresses.csv'] = process.argv.slice(2);
  if (!inPath) { console.error('Usage: node kibo-insider-lookup.js input.csv [output.csv]'); process.exit(1); }
  for (const k of ['KIBO_API_HOST', 'KIBO_CLIENT_ID', 'KIBO_CLIENT_SECRET']) {
    if (!process.env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
  }
  if (!TENANT_ID) { console.error('Missing KIBO_TENANT_ID in .env (numeric, e.g. 42004)'); process.exit(1); }
  console.log(`Host ${API_HOST} | tenant ${TENANT_ID} | site ${SITE_ID || '(none)'}`);

  // Fail fast: test one request before running thousands
  try { await kiboGet('/api/commerce/customer/accounts?pageSize=1'); }
  catch (e) { console.error('Pre-flight check failed:\n' + e.message); process.exit(1); }

  const rows = parseCsv(fs.readFileSync(inPath, 'utf8'));
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = header.indexOf(ID_COLUMN.toLowerCase());
  if (col < 0) { console.error(`Column "${ID_COLUMN}" not found. Headers: ${rows[0].join(', ')}`); process.exit(1); }
  const ids = rows.slice(1).map(r => (r[col] || '').trim());   // kept as strings: leading zeros survive
  const unique = [...new Set(ids.filter(Boolean))];
  console.log(`${ids.length} rows, ${unique.length} unique Insider IDs`);

  const results = new Map();   // externalId -> output row
  const errors = [];
  const batchSize = Math.max(1, parseInt(BATCH_SIZE, 10));
  const batches = [];
  for (let i = 0; i < unique.length; i += batchSize) batches.push(unique.slice(i, i + batchSize));

  let done = 0;
  await runPool(batches, Math.max(1, parseInt(CONCURRENCY, 10)), async batch => {
    try {
      const accounts = await findAccounts(batch);
      for (const acct of accounts) {
        const ext = String(acct.externalId ?? '').trim();
        if (!batch.includes(ext) || results.has(ext)) continue;
        const { billing: c, contacts } = await billingContact(acct);
        const common = { customerNumber: acct.id, phoneNumber: acct.userName };
        if (c) {
          const a = c.address || {};
          results.set(ext, {
            firstName: c.firstName, lastNameOrSurname: c.lastNameOrSurname,
            address1: a.address1, address2: a.address2, cityOrTown: a.cityOrTown,
            stateOrProvince: a.stateOrProvince, postalOrZipCode: a.postalOrZipCode,
            ...common,
          });
        } else {
          // No Billing contact: name from the account, else from any other contact
          const named = contacts.find(x => x.firstName || x.lastNameOrSurname) || {};
          results.set(ext, {
            firstName: acct.firstName || named.firstName,
            lastNameOrSurname: acct.lastName || named.lastNameOrSurname,
            address1: 'no billing address',
            noBilling: true,
            ...common,
          });
        }
      }
    } catch (e) {
      errors.push(e.message);
      for (const id of batch) results.set(id, { firstName: 'ERROR' });
    }
    done += batch.length;
    process.stdout.write(`\r${done}/${unique.length} looked up`);
  });
  console.log();

  const out = [OUTPUT_COLUMNS.join(',')];
  let found = 0, missing = 0, noBilling = 0, errored = 0;
  for (const id of ids) {
    const r = results.get(id) || { firstName: 'missing' };
    if (r.firstName === 'missing') missing++;
    else if (r.firstName === 'ERROR') errored++;
    else if (r.noBilling) noBilling++;
    else found++;
    out.push([id, r.firstName, r.lastNameOrSurname, r.address1, r.address2, r.cityOrTown,
      r.stateOrProvince, r.postalOrZipCode, r.customerNumber, r.phoneNumber].map(csvCell).join(','));
  }
  fs.writeFileSync(outPath, out.join('\r\n') + '\r\n');
  console.log(`Wrote ${outPath}: ${found} matched, ${noBilling} no billing address, ${missing} missing, ${errored} errored rows (${errors.length} failed batches)`);
  if (errors.length) console.error(errors.slice(0, 5).join('\n'));
})().catch(e => { console.error(e); process.exit(1); });