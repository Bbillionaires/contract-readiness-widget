// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // set in env
const app = express();
app.use(cors());
app.use(express.json());

// Load licenses from file (or use a DB in production)
const licensesPath = path.join(__dirname, 'licenses.json');
let licenses = JSON.parse(fs.readFileSync(licensesPath, 'utf8'));

function getDomainFromOrigin(originHeader) {
  try {
    if (!originHeader) return null;
    const url = new URL(originHeader);
    return url.hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

// GET /license?key=ABC123
app.get('/license', (req, res) => {
  const key = req.query.key;
  const origin = req.headers.origin || req.headers.referer;
  const domain = getDomainFromOrigin(origin);

  const lic = licenses[key];
  if (!lic || !lic.active) {
    return res.json({ active: false });
  }

  if (domain && Array.isArray(lic.allowed_domains) && lic.allowed_domains.length > 0) {
    const cleanDomain = domain.replace(/^www\./, '');
    const allowed = lic.allowed_domains.map(d => d.replace(/^www\./, ''));
    if (!allowed.includes(cleanDomain)) {
      return res.json({ active: false, reason: 'domain_not_allowed' });
    }
  }

  res.json({ active: true, plan: lic.plan || 'standard' });
});

// POST /log
app.post('/log', async (req, res) => {
  const { license, score, letter, insuranceStatus } = req.body || {};
  const origin = req.headers.origin || req.headers.referer;
  const domain = getDomainFromOrigin(origin);

  const lic = licenses[license];
  if (!lic || !lic.active) {
    return res.status(403).json({ ok: false, error: 'invalid_license' });
  }

  if (domain && Array.isArray(lic.allowed_domains) && lic.allowed_domains.length > 0) {
    const cleanDomain = domain.replace(/^www\./, '');
    const allowed = lic.allowed_domains.map(d => d.replace(/^www\./, ''));
    if (!allowed.includes(cleanDomain)) {
      return res.status(403).json({ ok: false, error: 'domain_not_allowed' });
    }
  }

  // 1) OPTIONAL: append to a basic log file
  const logLine = JSON.stringify({
    ts: new Date().toISOString(),
    license,
    score,
    letter,
    insuranceStatus,
    domain
  }) + '\n';
  fs.appendFile(path.join(__dirname, 'usage.log'), logLine, () => {});

  // 2) STRIPE METERED BILLING: report 1 unit usage for this submission
  try {
    if (lic.stripe_subscription_item_id) {
      await stripe.subscriptionItems.createUsageRecord(
        lic.stripe_subscription_item_id,
        {
          quantity: 1,
          timestamp: Math.floor(Date.now() / 1000),
          action: 'increment'
        }
      );
    }
  } catch (err) {
    console.error('Stripe usage error:', err);
    // do NOT fail the user; just log it
  }

  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('API listening on port', PORT);
});
