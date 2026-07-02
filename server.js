'use strict';
const express  = require('express');
const multer   = require('multer');
const https    = require('https');
const path     = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT         || 3000;
const TELNYX_KEY = process.env.TELNYX_KEY;
const SB_HOST    = 'dbesjatuunbyyoytffob.supabase.co';
const SB_KEY     = process.env.SUPABASE_KEY;
const DASH_PASS  = process.env.DASH_PASS    || 'kmc2026';
const WH_TOKEN   = process.env.WH_TOKEN     || 'lm-sms-2026';

const KMC_NUMBERS = ['+12109856004','+17869499467','+14709320125','+19163474799','+13126752435'];
const KMC_SET     = new Set(KMC_NUMBERS);
const STOP_RE     = /^(stop|unsubscribe|quit|cancel|end|remove me|opt.?out)[\s.!,]?$/i;
const YES_RE      = /^(yes|y|yep|yeah|sure|interested|definitely|ok|okay|sounds good|let'?s go|sign me up)[\s.!,]?$/i;
const NO_RE       = /^(no|nope|not interested|already sold|sold|never mind|nah|not selling)[\s.!,]?$/i;

// ── Supabase ──────────────────────────────────────────────────────────────────
function sbReq(method, table, body, qs) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = {
      apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', Accept: 'application/json',
    };
    if (method === 'POST')  h.Prefer = 'resolution=ignore-duplicates,return=representation';
    if (method === 'PATCH') h.Prefer = 'return=representation';
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({
      hostname: SB_HOST,
      path: `/rest/v1/${table}${qs ? '?' + qs : ''}`,
      method, headers: h,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, data: d ? JSON.parse(d) : null }); }
        catch { resolve({ ok: false, status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sb = {
  get:    (t, qs)    => sbReq('GET',    t, null, qs).then(r => Array.isArray(r.data) ? r.data : []),
  post:   (t, rows)  => sbReq('POST',   t, Array.isArray(rows) ? rows : [rows]),
  patch:  (t, qs, b) => sbReq('PATCH',  t, b, qs),
  del:    (t, qs)    => sbReq('DELETE', t, null, qs),
};

// ── Telnyx ────────────────────────────────────────────────────────────────────
function sendSMS(from, to, text) {
  return new Promise(resolve => {
    const body = JSON.stringify({ from, to, text });
    const req = https.request({
      hostname: 'api.telnyx.com', path: '/v2/messages', method: 'POST',
      headers: { Authorization: `Bearer ${TELNYX_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve({ ok: res.statusCode === 200, id: j?.data?.id, status: res.statusCode }); }
        catch { resolve({ ok: false, status: res.statusCode }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(body); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Auth ──────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const t = req.headers['x-dash-token'] || req.query.token;
  if (t === DASH_PASS) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const parts = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i+1] === '"') { f += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { parts.push(f.trim()); f = ''; }
    else f += c;
  }
  parts.push(f.trim());
  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Stats
app.get('/api/stats', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [campaigns, optOuts, replies, sentToday] = await Promise.all([
    sb.get('kmc_campaigns', 'select=id,status,total_contacts,sent_today'),
    sb.get('kmc_opt_outs',  'select=phone'),
    sb.get('kmc_replies',   'select=type'),
    sb.get('kmc_outbound',  `select=id&sent_at=gte.${today}T00:00:00Z`),
  ]);
  res.json({
    campaigns:      campaigns.length,
    active:         campaigns.filter(c => c.status === 'active').length,
    total_contacts: campaigns.reduce((a, c) => a + (c.total_contacts || 0), 0),
    opt_outs:       optOuts.length,
    sent_today:     sentToday.length,
    total_replies:  replies.length,
    yes_replies:    replies.filter(r => r.type === 'yes').length,
    no_replies:     replies.filter(r => r.type === 'no').length,
  });
});

// Campaigns
app.get('/api/campaigns', auth, async (req, res) => {
  res.json(await sb.get('kmc_campaigns', 'order=created_at.desc'));
});

app.post('/api/campaigns', auth, async (req, res) => {
  const { name, daily_limit, message, message_2, message_3, auto_reply_enabled, auto_reply_message, quiet_hours_enabled } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  const r = await sb.post('kmc_campaigns', {
    name, daily_limit: daily_limit || 200, message,
    message_2: message_2 || null, message_3: message_3 || null,
    auto_reply_enabled: !!auto_reply_enabled, auto_reply_message: auto_reply_message || null,
    quiet_hours_enabled: !!quiet_hours_enabled,
    status: 'draft', sent_today: 0, total_contacts: 0, last_sent_date: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  res.json(r.data?.[0] || { ok: r.ok });
});

app.patch('/api/campaigns/:id', auth, async (req, res) => {
  const r = await sb.patch('kmc_campaigns', `id=eq.${req.params.id}`, {
    ...req.body, updated_at: new Date().toISOString(),
  });
  res.json(r.data?.[0] || { ok: r.ok });
});

app.delete('/api/campaigns/:id', auth, async (req, res) => {
  await sb.del('kmc_contacts',  `campaign_id=eq.${req.params.id}`);
  await sb.del('kmc_campaigns', `id=eq.${req.params.id}`);
  res.json({ ok: true });
});

app.get('/api/campaigns/:id/stats', auth, async (req, res) => {
  const id = req.params.id;
  const [all, pending, sent, failed, opted] = await Promise.all([
    sb.get('kmc_contacts', `campaign_id=eq.${id}&select=id`),
    sb.get('kmc_contacts', `campaign_id=eq.${id}&status=eq.pending&select=id`),
    sb.get('kmc_contacts', `campaign_id=eq.${id}&status=eq.sent&select=id`),
    sb.get('kmc_contacts', `campaign_id=eq.${id}&status=eq.failed&select=id`),
    sb.get('kmc_contacts', `campaign_id=eq.${id}&status=eq.opted_out&select=id`),
  ]);
  res.json({ total: all.length, pending: pending.length, sent: sent.length, failed: failed.length, opted_out: opted.length });
});

// ── Column auto-detection (shared by preview + upload) ─────────────────────────
function detectColumns(rawHeaders) {
  const headers = rawHeaders.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = (...patterns) => headers.findIndex(h => patterns.some(p => (p instanceof RegExp ? p.test(h) : h === p || h.includes(p))));

  // Phone: prefer an exact/priority match over any column that merely contains "phone"
  // (e.g. prefer "mobilephone"/"cellphone"/"phone1" over "homephone" if both exist)
  let phoneIdx = find('mobilephone', 'cellphone', 'cellnumber', 'primaryphone', 'phone1', 'phonenumber', 'mobile', 'cell');
  if (phoneIdx < 0) phoneIdx = find(/phone/, /^tel/, 'telephone', 'contactnumber');

  let nameIdx = find('firstname', 'fname', 'ownername1', 'ownerfirstname', 'contactfirstname');
  if (nameIdx < 0) nameIdx = find('name', 'fullname', 'owner', 'ownername', 'contact', 'contactname');

  let addrIdx = find('propertyaddress', 'mailingaddress', 'siteaddress', 'streetaddress', 'address1');
  if (addrIdx < 0) addrIdx = find(/address/, 'street', 'addr');

  const cityIdx  = find('city', 'propertycity', 'mailingcity');
  const stIdx    = find('state', 'st', 'propertystate', 'mailingstate');
  const zipIdx   = find(/zip/, 'postalcode', 'postal');

  return { phoneIdx, nameIdx, addrIdx, cityIdx, stIdx, zipIdx };
}

// Preview a CSV's column mapping + a few sample rows before committing the import
app.post('/api/campaigns/:id/upload-preview', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const lines      = req.file.buffer.toString('utf-8').replace(/\r/g, '').split('\n').filter(l => l.trim());
  const rawHeaders = parseCSVLine(lines[0]);
  const map = detectColumns(rawHeaders);
  const sampleRows = lines.slice(1, 4).map(l => parseCSVLine(l));
  res.json({ headers: rawHeaders, map, sampleRows, totalRows: lines.length - 1 });
});

// Upload contacts
app.post('/api/campaigns/:id/upload', auth, upload.single('file'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const lines      = req.file.buffer.toString('utf-8').replace(/\r/g, '').split('\n');
  const rawHeaders = parseCSVLine(lines[0]);
  const auto = detectColumns(rawHeaders);

  // Allow the frontend to override any auto-detected column after user confirms the mapping preview
  const toIdx = v => (v === undefined || v === '' || v === null) ? undefined : parseInt(v);
  const phoneIdx = toIdx(req.body.phoneCol) ?? auto.phoneIdx;
  const nameIdx  = toIdx(req.body.nameCol)  ?? auto.nameIdx;
  const addrIdx  = toIdx(req.body.addrCol)  ?? auto.addrIdx;
  const cityIdx  = toIdx(req.body.cityCol)  ?? auto.cityIdx;
  const stIdx    = toIdx(req.body.stateCol) ?? auto.stIdx;
  const zipIdx   = toIdx(req.body.zipCol)   ?? auto.zipIdx;

  if (phoneIdx < 0 || phoneIdx === undefined) return res.status(400).json({ error: 'No phone column found in CSV — please map it manually' });

  const [optOutRows, thisCampRows, otherCampRows, outboundRows] = await Promise.all([
    sb.get('kmc_opt_outs',  'select=phone'),
    sb.get('kmc_contacts',  `campaign_id=eq.${id}&select=phone`),
    sb.get('kmc_contacts',  `campaign_id=neq.${id}&select=phone,status`),
    sb.get('kmc_outbound',  'select=to'),
  ]);
  const optOuts  = new Set(optOutRows.map(r => r.phone));
  const existing = new Set(thisCampRows.map(r => r.phone));
  // Cross-campaign safety net: anyone already in another campaign (queued or already sent),
  // or with any outbound send history at all, gets skipped so we never double-text a lead
  // just because they were uploaded into more than one list.
  const alreadyContacted = new Set([
    ...otherCampRows.map(r => r.phone),
    ...outboundRows.map(r => r.to),
  ]);
  const batch = []; let invalid = 0, dupes = 0, blocked = 0, crossCampaign = 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p   = parseCSVLine(lines[i]);
    const raw = (p[phoneIdx] || '').replace(/\D/g, '');
    if (raw.length < 10) { invalid++; continue; }
    const phone = '+1' + raw.slice(-10);
    if (optOuts.has(phone))         { blocked++; continue; }
    if (existing.has(phone))        { dupes++; continue; }
    if (alreadyContacted.has(phone)){ crossCampaign++; continue; }
    existing.add(phone);
    alreadyContacted.add(phone);

    const addr  = addrIdx >= 0 ? (p[addrIdx] || '').trim() : '';
    const city  = cityIdx >= 0 ? (p[cityIdx] || '').trim() : '';
    const state = stIdx   >= 0 ? (p[stIdx]   || '').trim() : '';
    const zip   = zipIdx  >= 0 ? (p[zipIdx]  || '').trim() : '';
    const fullAddr = [addr, city && state ? `${city}, ${state}` : city || state, zip].filter(Boolean).join(' ').trim();

    batch.push({
      campaign_id: parseInt(id), phone,
      first_name: nameIdx >= 0 ? (p[nameIdx] || '').trim() : '',
      address: fullAddr, status: 'pending',
      created_at: new Date().toISOString(),
    });
  }

  let inserted = 0;
  for (let i = 0; i < batch.length; i += 100) {
    const r = await sb.post('kmc_contacts', batch.slice(i, i + 100));
    if (r.ok && r.data) inserted += r.data.length;
  }

  const total = (await sb.get('kmc_contacts', `campaign_id=eq.${id}&select=id`)).length;
  await sb.patch('kmc_campaigns', `id=eq.${id}`, { total_contacts: total, updated_at: new Date().toISOString() });
  res.json({ inserted, dupes, blocked, invalid, crossCampaign, total_in_campaign: total });
});

app.get('/api/campaigns/:id/contacts', auth, async (req, res) => {
  const { status, limit = 200, offset = 0 } = req.query;
  let qs = `campaign_id=eq.${req.params.id}&order=created_at.asc&limit=${limit}&offset=${offset}`;
  if (status) qs += `&status=eq.${status}`;
  res.json(await sb.get('kmc_contacts', qs));
});

// Activate / Pause
app.post('/api/campaigns/:id/activate', auth, async (req, res) => {
  await sb.patch('kmc_campaigns', `id=eq.${req.params.id}`, { status: 'active', updated_at: new Date().toISOString() });
  res.json({ ok: true });
});
app.post('/api/campaigns/:id/pause', auth, async (req, res) => {
  await sb.patch('kmc_campaigns', `id=eq.${req.params.id}`, { status: 'paused', updated_at: new Date().toISOString() });
  res.json({ ok: true });
});

// Blast engine
const SEND_TIMEZONE = 'America/New_York'; // Render's server clock runs in UTC — always compute the send window in Eastern time explicitly, never server-local time

function inQuietHours() {
  // Compliance-friendly send window: 9:00 AM – 8:59 PM Eastern (covers TCPA's 8am-9pm recipient-local guidance
  // reasonably well for a KMC number base that's largely Central/Eastern; adjust SEND_TIMEZONE above if needed)
  const hr = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: SEND_TIMEZONE }).format(new Date()));
  return hr < 9 || hr >= 21;
}

async function runBlast(campaign) {
  const id      = campaign.id;
  const today   = new Date().toISOString().slice(0, 10);
  const sentSoFar = campaign.last_sent_date === today ? (campaign.sent_today || 0) : 0;
  const cap       = (campaign.daily_limit || 200) - sentSoFar;
  if (cap <= 0) return { sent: 0, reason: 'daily limit reached' };

  if (campaign.quiet_hours_enabled && inQuietHours()) {
    return { sent: 0, reason: 'quiet hours (9am-9pm window)' };
  }

  const pending = await sb.get('kmc_contacts', `campaign_id=eq.${id}&status=eq.pending&limit=${cap}&order=created_at.asc`);
  if (!pending.length) {
    await sb.patch('kmc_campaigns', `id=eq.${id}`, { status: 'completed', updated_at: new Date().toISOString() });
    return { sent: 0, reason: 'completed' };
  }

  // Build the pool of available message variants (1-3), rotated round-robin per contact
  const variants = [campaign.message, campaign.message_2, campaign.message_3].filter(v => v && v.trim());

  const optOuts = new Set((await sb.get('kmc_opt_outs', 'select=phone')).map(r => r.phone));
  let sent = 0, failed = 0, ni = 0;

  for (const contact of pending) {
    if (optOuts.has(contact.phone)) {
      await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { status: 'opted_out' });
      continue;
    }
    const from = KMC_NUMBERS[ni % KMC_NUMBERS.length];
    const variantIdx = ni % variants.length;
    const template = variants[variantIdx];
    ni++;
    const text = (template || '')
      .replace(/\{name\}/gi,    contact.first_name || '')
      .replace(/\{address\}/gi, contact.address    || '');

    const r  = await sendSMS(from, contact.phone, text);
    const st = r.ok ? 'sent' : 'failed';

    await Promise.all([
      sb.post('kmc_outbound', { campaign_id: id, from, to: contact.phone, text, status: st, telnyx_id: r.id || null, sent_at: new Date().toISOString() }),
      sb.patch('kmc_contacts', `id=eq.${contact.id}`, { status: st, sent_at: new Date().toISOString(), assigned_from: from, message_variant: variantIdx + 1 }),
    ]);

    if (r.ok) sent++; else failed++;
    // Human-like jitter: 1.8s-2.8s between sends instead of a fixed robotic cadence
    await sleep(1800 + Math.floor(Math.random() * 1000));
  }

  await sb.patch('kmc_campaigns', `id=eq.${id}`, {
    sent_today: sentSoFar + sent, last_sent_date: today, updated_at: new Date().toISOString(),
  });
  console.log(`[Blast] "${campaign.name}" → sent:${sent} failed:${failed}`);
  return { sent, failed };
}

app.post('/api/campaigns/:id/blast', auth, async (req, res) => {
  const campaigns = await sb.get('kmc_campaigns', `id=eq.${req.params.id}`);
  if (!campaigns.length) return res.status(404).json({ error: 'Not found' });
  const c = campaigns[0];
  if (c.status === 'completed') return res.json({ ok: false, message: 'Campaign already completed' });

  const today   = new Date().toISOString().slice(0, 10);
  const soFar   = c.last_sent_date === today ? (c.sent_today || 0) : 0;
  const cap     = (c.daily_limit || 200) - soFar;
  const pending = await sb.get('kmc_contacts', `campaign_id=eq.${req.params.id}&status=eq.pending&select=id`);

  res.json({ ok: true, queued: Math.min(pending.length, Math.max(0, cap)), cap, pending: pending.length });
  setImmediate(() => runBlast(c));
});

// Inbox
app.get('/api/inbox', auth, async (req, res) => {
  const [inbound, outbound, contacts, campaigns] = await Promise.all([
    sb.get('kmc_replies',  'order=timestamp.desc&limit=2000'),
    sb.get('kmc_outbound', 'order=sent_at.desc&limit=2000'),
    sb.get('kmc_contacts', 'select=phone,first_name,campaign_id&order=created_at.desc&limit=50000'),
    sb.get('kmc_campaigns','select=id,auto_reply_enabled,auto_reply_message'),
  ]);

  // Build phone → { name, campaign } lookup (most recently-created contact record wins if a phone appears more than once)
  const campById = {}; for (const c of campaigns) campById[c.id] = c;
  const contactByPhone = {};
  for (const c of contacts) {
    if (!c.phone || contactByPhone[c.phone]) continue;
    contactByPhone[c.phone] = { name: (c.first_name || '').trim(), campaign: campById[c.campaign_id] || null };
  }

  const m = {};
  for (const r of outbound) {
    if (!r.to) continue;
    if (!m[r.to]) m[r.to] = { phone: r.to, messages: [], lastActivity: '', hasReplied: false, replyType: null };
    m[r.to].messages.push({ id: r.id, dir: 'out', text: r.text, ts: r.sent_at, from: r.from });
    if (r.sent_at > m[r.to].lastActivity) m[r.to].lastActivity = r.sent_at;
  }
  for (const r of inbound) {
    const p = r.from;
    if (!m[p]) m[p] = { phone: p, messages: [], lastActivity: '', hasReplied: true, replyType: r.type };
    m[p].messages.push({ id: r.id, dir: 'in', text: r.text, ts: r.timestamp, type: r.type, to: r.to });
    m[p].hasReplied = true; m[p].replyType = r.type;
    if (r.timestamp > m[p].lastActivity) m[p].lastActivity = r.timestamp;
  }

  const convs = Object.values(m).map(c => {
    c.messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    c.preview = c.messages.at(-1)?.text?.slice(0, 60) || '';
    const contact = contactByPhone[c.phone];
    c.name = contact?.name || '';
    const camp = contact?.campaign;
    c.autoReplyMessage = (camp?.auto_reply_enabled && camp.auto_reply_message) ? camp.auto_reply_message : null;
    return c;
  }).sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  res.json(convs);
});

// Test send — preview any of the 3 variants (or auto-reply) to a single number, no contact/campaign side-effects
app.post('/api/campaigns/:id/test-send', auth, async (req, res) => {
  const { to, variant } = req.body; // variant: 1, 2, 3, or 'auto_reply'
  if (!to) return res.status(400).json({ error: 'to required' });
  const campaigns = await sb.get('kmc_campaigns', `id=eq.${req.params.id}`);
  const c = campaigns[0];
  if (!c) return res.status(404).json({ error: 'Not found' });
  const raw = to.replace(/\D/g, '');
  const phone = '+1' + raw.slice(-10);
  let template;
  if (variant === 'auto_reply') template = c.auto_reply_message;
  else if (variant == 2) template = c.message_2;
  else if (variant == 3) template = c.message_3;
  else template = c.message;
  if (!template?.trim()) return res.status(400).json({ error: 'That variant is empty' });
  const text = template.replace(/\{name\}/gi, 'Test').replace(/\{address\}/gi, '123 Sample St');
  const r = await sendSMS(KMC_NUMBERS[0], phone, `[TEST] ${text}`);
  res.json({ ok: r.ok, id: r.id, status: r.status, text });
});

// Manual send
app.post('/api/send', auth, async (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.status(400).json({ error: 'from, to, text required' });
  if (!KMC_SET.has(from))   return res.status(400).json({ error: 'Invalid from number' });
  const optOut = await sb.get('kmc_opt_outs', `phone=eq.${encodeURIComponent(to)}`);
  if (optOut.length) return res.status(400).json({ error: 'Number has opted out' });
  const r = await sendSMS(from, to, text);
  if (r.ok) await sb.post('kmc_outbound', { campaign_id: null, from, to, text, status: 'sent', telnyx_id: r.id || null, sent_at: new Date().toISOString() });
  res.json({ ok: r.ok, id: r.id, status: r.status });
});

// Delete a single message (inbound from kmc_replies, outbound from kmc_outbound)
app.delete('/api/messages/:id', auth, async (req, res) => {
  const { dir } = req.query; // 'in' or 'out'
  const table = dir === 'out' ? 'kmc_outbound' : 'kmc_replies';
  await sb.del(table, `id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// Reclassify an inbound message type (yes / no / other)
app.patch('/api/messages/:id/type', auth, async (req, res) => {
  const { type } = req.body;
  if (!['yes','no','other'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  await sb.patch('kmc_replies', `id=eq.${req.params.id}`, { type });
  res.json({ ok: true });
});

// Opt-outs
app.get('/api/opt-outs', auth, async (req, res) => {
  res.json(await sb.get('kmc_opt_outs', 'order=created_at.desc&limit=2000'));
});
app.post('/api/opt-outs', auth, async (req, res) => {
  const { phone, reason } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const raw  = phone.replace(/\D/g, '');
  const e164 = '+1' + raw.slice(-10);
  await sb.post('kmc_opt_outs', { phone: e164, reason: reason || 'manual', created_at: new Date().toISOString() });
  res.json({ ok: true, phone: e164 });
});
app.delete('/api/opt-outs/:phone', auth, async (req, res) => {
  await sb.del('kmc_opt_outs', `phone=eq.${encodeURIComponent(decodeURIComponent(req.params.phone))}`);
  res.json({ ok: true });
});

// Telnyx inbound webhook — auto opt-out on STOP, save to kmc_replies
app.post('/webhook/sms', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.status(401).end();
  res.sendStatus(200);
  try {
    const ev = req.body;
    if (ev.data?.event_type !== 'message.received') return;
    const msg  = ev.data.payload;
    const from = msg.from?.phone_number;
    const to   = msg.to?.[0]?.phone_number;
    const text = (msg.text || '').trim();
    if (!from || !to || !KMC_SET.has(to)) return;

    let type = 'other';
    if (STOP_RE.test(text)) {
      type = 'no';
      await Promise.all([
        sb.post('kmc_opt_outs', { phone: from, reason: 'STOP message', created_at: new Date().toISOString() }),
        sb.patch('kmc_contacts', `phone=eq.${encodeURIComponent(from)}`, { status: 'opted_out' }),
      ]);
    } else if (NO_RE.test(text))  type = 'no';
    else if (YES_RE.test(text)) type = 'yes';

    await sb.post('kmc_replies', { from, to, text, type, timestamp: new Date().toISOString(), synced: false });
    console.log(`[Inbound] ${type.toUpperCase()} | ${from} → ${to} | "${text.slice(0, 60)}"`);

    // Auto-reply on interest: find which campaign this contact belongs to and,
    // if that campaign has an auto-reply configured, send it once.
    if (type === 'yes') {
      const contacts = await sb.get('kmc_contacts', `phone=eq.${encodeURIComponent(from)}&order=created_at.desc&limit=1`);
      const contact = contacts[0];
      if (contact && !contact.auto_replied && contact.campaign_id) {
        const camps = await sb.get('kmc_campaigns', `id=eq.${contact.campaign_id}`);
        const camp = camps[0];
        if (camp?.auto_reply_enabled && camp.auto_reply_message?.trim()) {
          const replyFrom = contact.assigned_from && KMC_SET.has(contact.assigned_from) ? contact.assigned_from : to;
          const replyText = camp.auto_reply_message
            .replace(/\{name\}/gi,    contact.first_name || '')
            .replace(/\{address\}/gi, contact.address    || '');
          const r = await sendSMS(replyFrom, from, replyText);
          await Promise.all([
            sb.post('kmc_outbound', { campaign_id: camp.id, from: replyFrom, to: from, text: replyText, status: r.ok ? 'sent' : 'failed', telnyx_id: r.id || null, sent_at: new Date().toISOString() }),
            sb.patch('kmc_contacts', `id=eq.${contact.id}`, { auto_replied: true }),
          ]);
          console.log(`[AutoReply] ${camp.name} → ${from} | "${replyText.slice(0, 60)}"`);
        }
      }
    }
  } catch(e) { console.error('[webhook]', e.message); }
});

// Auto-blast active campaigns every 10 minutes
setInterval(async () => {
  try {
    const active = await sb.get('kmc_campaigns', 'status=eq.active&order=updated_at.asc');
    for (const c of active) await runBlast(c);
  } catch(e) { console.error('[auto-blast]', e.message); }
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`KMC Blast Dashboard → http://localhost:${PORT}`));
