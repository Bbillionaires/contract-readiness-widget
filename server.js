// server.js – full version with Stripe webhook, admin, usage metrics

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const crypto = require('crypto');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// --- License file loading + saving ---

const licensesPath = path.join(__dirname, 'licenses.json');
let licenses = {};

try {
  const raw = fs.readFileSync(licensesPath, 'utf8');
  licenses = JSON.parse(raw);
  console.log('Loaded licenses:', Object.keys(licenses));
} catch (err) {
  console.error('Failed to load licenses.json:', err.message);
  licenses = {};
}

function saveLicenses() {
  try {
    fs.writeFileSync(licensesPath, JSON.stringify(licenses, null, 2));
    console.log('Licenses saved.');
  } catch (err) {
    console.error('Failed to save licenses.json:', err.message);
  }
}

// Helper: extract domain from Origin/Referer
function getDomainFromOrigin(originHeader) {
  try {
    if (!originHeader) return null;
    const u = new URL(originHeader);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

// --- Basic health check ---
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Contract Readiness API running' });
});

// --- License check endpoint ---
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

  return res.json({
    active: true,
    plan: lic.plan || 'standard'
  });
});

// --- Usage log endpoint + optional Stripe metered billing ---
app.post('/log', async (req, res) => {
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

  fs.appendFile(path.join(__dirname, 'usage.log'), logLine, err => {
    if (err) console.error('Failed to write usage log:', err.message);
  });

  // Stripe metered billing (optional)
  try {
    const lic = licenses[license];
    if (stripe && lic && lic.stripe_subscription_item_id) {
      await stripe.subscriptionItems.createUsageRecord(
        lic.stripe_subscription_item_id,
        {
          quantity: 1,
          timestamp: Math.floor(Date.now() / 1000),
          action: 'increment'
        }
      );
      console.log('Usage recorded for license:', license);
    }
  } catch (err) {
    console.error('Stripe usage error:', err.message);
  }

  res.json({ ok: true });
});

// --- Admin auth + routes ---

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.admin;
  if (!ADMIN_SECRET || token !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

// List licenses with search + sorted newest first
app.get('/admin/licenses', requireAdmin, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const items = Object.entries(licenses).map(([key, lic]) => ({
    key,
    ...lic
  }));

  let filtered = items;
  if (search) {
    filtered = items.filter(item =>
      (item.first_name || '').toLowerCase().includes(search) ||
      (item.last_name || '').toLowerCase().includes(search) ||
      (item.email || '').toLowerCase().includes(search) ||
      (item.company || '').toLowerCase().includes(search) ||
      item.key.toLowerCase().includes(search)
    );
  }

  filtered.sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta; // newest first
  });

  res.json({ ok: true, licenses: filtered });
});

// Toggle active/inactive
app.patch('/admin/licenses/:key', requireAdmin, (req, res) => {
  const key = req.params.key;
  const lic = licenses[key];
  if (!lic) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const body = req.body || {};
  if (typeof body.active === 'boolean') {
    lic.active = body.active;
  }

  saveLicenses();
  res.json({ ok: true, license: { key, ...lic } });
});

// Usage metrics from usage.log
app.get('/admin/usage', requireAdmin, (req, res) => {
  const usageFile = path.join(__dirname, 'usage.log');

  fs.readFile(usageFile, 'utf8', (err, data) => {
    if (err || !data || !data.trim()) {
      return res.json({ ok: true, total_events: 0, last_ts: null, stats: {} });
    }

    const lines = data.trim().split('\n');
    const stats = {};
    let lastTs = null;

    lines.forEach(line => {
      try {
        const entry = JSON.parse(line);
        const lic = entry.license || 'UNKNOWN';
        const ts = entry.ts || entry.timestamp || null;

        if (!stats[lic]) {
          stats[lic] = { count: 0, last_ts: null };
        }
        stats[lic].count += 1;
        if (ts) {
          if (!stats[lic].last_ts || new Date(ts) > new Date(stats[lic].last_ts)) {
            stats[lic].last_ts = ts;
          }
          if (!lastTs || new Date(ts) > new Date(lastTs)) {
            lastTs = ts;
          }
        }
      } catch (e) {
        // ignore bad lines
      }
    });

    res.json({
      ok: true,
      total_events: lines.length,
      last_ts: lastTs,
      stats
    });
  });
});

// --- Lookup endpoint (used by thank-you page, email-based) ---
app.get('/lookup', async (req, res) => {
  try {
    let email = (req.query.email || '').trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ ok: false, error: 'missing_email' });
    }

    const matches = Object.entries(licenses)
      .filter(([key, lic]) => (lic.email || '').toLowerCase() === email)
      .map(([key, lic]) => ({ key, ...lic }));

    if (!matches.length) {
      return res.json({ ok: false, error: 'no_license_found_for_email', email });
    }

    matches.sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return tb - ta;
    });

    const latest = matches[0];

    res.json({
      ok: true,
      license_key: latest.key,
      license: latest
    });
  } catch (err) {
    console.error('Lookup error:', err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// --- Stripe webhook: auto-create licenses on successful checkout ---
app.post('/stripe/webhook', (req, res) => {
  if (!stripe) {
    // If Stripe not configured, just acknowledge
    return res.json({ received: true, message: 'Stripe not configured' });
  }

  const event = req.body;

  if (event && event.type === 'checkout.session.completed') {
    const session = event.data && event.data.object;

    if (session) {
      const email = (session.customer_details && session.customer_details.email) || '';
      const fullName = (session.customer_details && session.customer_details.name) || '';
      const parts = fullName.trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';

      // Try to get domain from custom_fields (if set up in Stripe)
      let domain = '';
      if (Array.isArray(session.custom_fields)) {
        const field = session.custom_fields.find(f => f.key === 'website_domain');
        if (field && field.text && field.text.value) {
          domain = field.text.value.trim().toLowerCase();
        }
      }

      // Generate random license key (16 hex chars)
      const licenseKey = crypto.randomBytes(8).toString('hex').toUpperCase();

      licenses[licenseKey] = {
        active: true,
        first_name: firstName,
        last_name: lastName,
        email: email,
        company: session.client_reference_id || '',
        allowed_domains: domain ? [domain] : [],
        stripe_customer_id: session.customer || '',
        stripe_subscription_item_id: '', // can be filled later
        plan: 'standard',
        created_at: new Date().toISOString()
      };

      saveLicenses();
      console.log('Created license from Stripe webhook:', licenseKey, email);
    }
  }

  res.json({ received: true });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log('API listening on port', PORT);
});
