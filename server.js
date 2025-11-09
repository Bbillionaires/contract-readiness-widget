// server.js – API for Contract Readiness Widget
// Features:
// - License check
// - Usage logging
// - Full submission logging
// - Per-license email notifications
// - Stripe webhook for auto-license creation
// - Admin endpoints for licenses & usage

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------- Email configuration ----------------

const OWNER_NOTIFICATION_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || '';
const EMAIL_FROM = process.env.EMAIL_FROM || OWNER_NOTIFICATION_EMAIL || '';

let emailEnabled = false;
let transporter = null;

if (
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS &&
  OWNER_NOTIFICATION_EMAIL &&
  EMAIL_FROM
) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  emailEnabled = true;
  console.log('Email notifications enabled.');
} else {
  console.log('Email notifications NOT fully configured. Submissions will only be logged to file.');
}

// --------------- Basic middleware / logging ------------

app.use((req, res, next) => {
  console.log('Incoming:', req.method, req.path);
  next();
});

app.use(cors());
app.use(express.json());

// --------------- Files / storage paths -----------------

const licensesPath = path.join(__dirname, 'licenses.json');
const submissionsPath = path.join(__dirname, 'submissions.log');
const usagePath = path.join(__dirname, 'usage.log');

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

function getDomainFromOrigin(originHeader) {
  try {
    if (!originHeader) return null;
    const u = new URL(originHeader);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return null;
  }
}

// ----------------- Health check -----------------------

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Contract Readiness API running' });
});

// ----------------- License check ----------------------

app.get('/license', (req, res) => {
  const key = req.query.key || '';
  const lic = licenses[key];

  if (!lic || !lic.active) {
    return res.json({ active: false });
  }

  // Optional domain restriction
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

// --------------- Usage logging (/log) -----------------

app.post('/log', async (req, res) => {
  const {
    license,
    basic_score,
    basic_letter,
    advanced_score,
    advanced_letter,
    insuranceStatus
  } = req.body || {};

  const origin = req.headers.origin || req.headers.referer || '';
  const reqDomain = getDomainFromOrigin(origin);

  const logLine = JSON.stringify({
    ts: new Date().toISOString(),
    license,
    basic_score,
    basic_letter,
    advanced_score,
    advanced_letter,
    insuranceStatus,
    domain: reqDomain
  }) + '\n';

  fs.appendFile(usagePath, logLine, err => {
    if (err) console.error('Failed to write usage log:', err.message);
  });

  // Optional Stripe metered usage
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

// ------- Full submission logging + per-license emails -------

app.post('/submit-form', async (req, res) => {
  try {
    const body = req.body || {};
    const origin = req.headers.origin || req.headers.referer || '';
    const reqDomain = getDomainFromOrigin(origin);

    const record = {
      ts: new Date().toISOString(),
      license: body.license || '',
      contact: body.contact || {},
      core_answers: body.core_answers || {},
      advanced_answers: body.advanced_answers || {},
      scores: body.scores || {},
      domain: reqDomain
    };

    // Save to submissions.log (one JSON per line)
    fs.appendFileSync(submissionsPath, JSON.stringify(record) + '\n');

    let emailedOwner = false;
    let emailedUser = false;

    if (emailEnabled) {
      const contactEmail = (record.contact.email || '').trim();
      const contactName =
        record.contact.contact_name ||
        record.contact.name ||
        '';

      // Build summary text for owner + user
      const summaryLines = [];
      summaryLines.push('New Contract Readiness Submission');
      summaryLines.push('--------------------------------');
      summaryLines.push(`Timestamp: ${record.ts}`);
      summaryLines.push(`Domain: ${record.domain || ''}`);
      summaryLines.push(`License: ${record.license}`);
      summaryLines.push('');
      summaryLines.push(`Company: ${record.contact.company_name || ''}`);
      summaryLines.push(`Contact: ${contactName}`);
      summaryLines.push(`Email: ${contactEmail}`);
      summaryLines.push(`Phone: ${record.contact.phone || ''}`);
      summaryLines.push(`Website: ${record.contact.website || ''}`);
      summaryLines.push('');
      summaryLines.push(
        `Basic Score: ${record.scores.basic_score ?? ''} (${record.scores.basic_letter || ''})`
      );
      summaryLines.push(
        `Advanced Score: ${record.scores.advanced_score ?? 'N/A'} (${record.scores.advanced_letter || ''})`
      );
      summaryLines.push('');
      summaryLines.push('Core Answers:');
      Object.entries(record.core_answers).forEach(([k, v]) => {
        summaryLines.push(`- ${k}: ${v}`);
      });
      summaryLines.push('');
      summaryLines.push('Advanced Answers:');
      Object.entries(record.advanced_answers).forEach(([k, v]) => {
        summaryLines.push(`- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      });

      const summaryText = summaryLines.join('\n');

      // Decide which email gets the owner-style notification:
      // 1) If the license has a notify_email, use that
      // 2) Else use OWNER_NOTIFICATION_EMAIL
      let ownerTo = OWNER_NOTIFICATION_EMAIL;
      if (record.license && licenses[record.license] && licenses[record.license].notify_email) {
        ownerTo = licenses[record.license].notify_email;
      }

      if (ownerTo) {
        try {
          await transporter.sendMail({
            from: EMAIL_FROM,
            to: ownerTo,
            subject: 'New Contract Readiness Submission',
            text: summaryText
          });
          emailedOwner = true;
        } catch (err) {
          console.error('Owner email error:', err.message);
        }
      }

      // Email to user (if they provided an email)
      if (contactEmail) {
        try {
          await transporter.sendMail({
            from: EMAIL_FROM,
            to: contactEmail,
            subject: 'Your Contract Readiness Results',
            text: summaryText
          });
          emailedUser = true;
        } catch (err) {
          console.error('User email error:', err.message);
        }
      }
    }

    res.json({ ok: true, emailed_owner: emailedOwner, emailed_user: emailedUser });
  } catch (err) {
    console.error('submit-form error:', err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ----------------- Admin auth / helpers ----------------

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.admin;
  if (!ADMIN_SECRET || token !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

// List licenses (with search)
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
      (item.notify_email || '').toLowerCase().includes(search) ||
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

// Update license (active, notify_email, allowed_domains, company)
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
  if (typeof body.notify_email === 'string') {
    lic.notify_email = body.notify_email.trim();
  }
  if (Array.isArray(body.allowed_domains)) {
    lic.allowed_domains = body.allowed_domains.map(d => d.trim()).filter(Boolean);
  }
  if (typeof body.company === 'string') {
    lic.company = body.company.trim();
  }

  saveLicenses();
  res.json({ ok: true, license: { key, ...lic } });
});

// Usage metrics
app.get('/admin/usage', requireAdmin, (req, res) => {
  fs.readFile(usagePath, 'utf8', (err, data) => {
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
        // ignore malformed line
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

// -------------- Lookup license by email ----------------

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

// -------------- Stripe webhook: auto licenses ----------

app.post('/stripe/webhook', (req, res) => {
  console.log('Webhook hit:', req.body && req.body.type, 'id:', req.body && req.body.id);

  if (!stripe) {
    console.log('Stripe not configured: STRIPE_SECRET_KEY is missing');
    return res.json({ received: true, message: 'Stripe not configured' });
  }

  const event = req.body;

  if (event && event.type === 'checkout.session.completed') {
    console.log('Processing checkout.session.completed event');

    const session = event.data && event.data.object;

    if (session) {
      const email = (session.customer_details && session.customer_details.email) || '';
      const fullName = (session.customer_details && session.customer_details.name) || '';
      const parts = fullName.trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';

      let domain = '';
      if (Array.isArray(session.custom_fields)) {
        const field = session.custom_fields.find(f => f.key === 'website_domain');
        if (field && field.text && field.text.value) {
          domain = field.text.value.trim().toLowerCase();
        }
      }

      // Generate a license key
      const licenseKey = crypto.randomBytes(8).toString('hex').toUpperCase();

      licenses[licenseKey] = {
        active: true,
        first_name: firstName,
        last_name: lastName,
        email: email,
        company: session.client_reference_id || '',
        allowed_domains: domain ? [domain] : [],
        stripe_customer_id: session.customer || '',
        stripe_subscription_item_id: '',
        plan: 'standard',
        created_at: new Date().toISOString()
        // You can set notify_email later via admin.html without editing files
      };

      saveLicenses();
      console.log('Created license from Stripe webhook:', licenseKey, email);
    }
  } else {
    console.log('Webhook event type ignored:', event && event.type);
  }

  res.json({ received: true });
});

// ----------------- Start server ------------------------

app.listen(PORT, () => {
  console.log('API listening on port', PORT);
});
