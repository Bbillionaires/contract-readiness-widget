// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Load licenses
let licenses = {};
try {
  const licensesPath = path.join(__dirname, 'licenses.json');
  const raw = fs.readFileSync(licensesPath, 'utf8');
  licenses = JSON.parse(raw);
  console.log('Loaded licenses:', Object.keys(licenses));
} catch (err) {
  console.error('Failed to load licenses.json:', err.message);
}

// Helper to extract domain from Origin/Referer
function getDomainFromOrigin(originHeader) {
  try {
    if (!originHeader) return null;
    const u = new URL(originHeader);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Contract Readiness API running' });
});

// License check endpoint
app.get('/license', (req, res) => {
  const key = req.query.key || '';
  const lic = licenses[key];

  if (!lic || !lic.active) {
    return res.json({ active: false });
  }

  // Optional domain lock
  const origin = req.headers.origin || req.headers.referer || '';
  const reqDomain = getDomainFromOrigin(origin);
  if (lic.allowed_domains && lic.allowed_domains.length && reqDomain) {
    const allowed = lic.allowed_domains.map(d => d.replace(/^www\./, ''));
    const cleanReq = reqDomain.replace(/^www\./, '');
    if (!allowed.includes(cleanReq)) {
      return res.json({ active: false, reason: 'domain_not_allowed' });
    }
  }

  return res.json({ active: true, plan: lic.plan || 'standard' });
});

// Usage log endpoint
app.post('/log', (req, res) => {
  const { license, score, letter, insuranceStatus } = req.body || {};
  const origin = req.headers.origin || req.headers.referer || '';
  const reqDomain = getDomainFromOrigin(origin);

  const logLine = JSON.stringify({
    ts: new Date().toISOString(),
    license,
    score,
    letter,
    insuranceStatus,
    domain: reqDomain
  }) + '\n';

  fs.appendFile(path.join(__dirname, 'usage.log'), logLine, (err) => {
    if (err) console.error('Failed to write usage log:', err.message);
  });

  // Stripe metered billing could go here (disabled for now)

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log('API listening on port', PORT);
});
