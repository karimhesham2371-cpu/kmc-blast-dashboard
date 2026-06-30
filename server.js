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
  const { name, daily_limit, message } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  const r = await sb.post('kmc_campaigns', {
    name, daily_limit: daily_limit || 200, message,
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

// Upload contacts
app.post('/api/campaigns/:id/upload', auth, upload.single('file'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const lines   = req.file.buffer.toString('utf-8').replace(/\r/g, '').split('\n');
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const phoneIdx = headers.findIndex(h => h.includes('phone'));
  const nameIdx  = headers.findIndex(h => h.includes('first') || h === 'name');
  const addrIdx  = headers.findIndex(h => h.includes('address'));
  const cityIdx  = headers.findIndex(h => h === 'city');
  const stIdx    = headers.findIndex(h => h === 'state');
  const zipIdx   = headers.findIndex(h => h.includes('zip'));

  if (phoneIdx < 0) return res.status(400).json({ error: 'No phone column found in CSV' });

  const optOuts  = new Set((await sb.get('kmc_opt_outs', 'select=phone')).map(r => r.phone));
  const existing = new Set((await sb.get('kmc_contacts', `campaign_id=eq.${id}&select=phone`)).map(r => r.phone));
  const batch = []; let invalid = 0, dupes = 0, blocked = 0;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p   = parseCSVLine(lines[i]);
    const raw = (p[phoneIdx] || '').replace(/\D/g, '');
    if (raw.length < 10) { invalid++; continue; }
    const phone = '+1' + raw.slice(-10);
    if (optOuts.has(phone))  { blocked++; continue; }
    if (existing.has(phone)) { dupes++; continue; }
    existing.add(phone);

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
  res.json({ inserted, dupes, blocked, invalid, total_in_campaign: total });
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
async function runBlast(campaign) {
  const id      = campaign.id;
  const today   = new Date().toISOString().slice(0, 10);
  const sentSoFar = campaign.last_sent_date === today ? (campaign.sent_today || 0) : 0;
  const cap       = (campaign.daily_limit || 200) - sentSoFar;
  if (cap <= 0) return { sent: 0, reason: 'daily limit reached' };

  const pending = await sb.get('kmc_contacts', `campaign_id=eq.${id}&status=eq.pending&limit=${cap}&order=created_at.asc`);
  if (!pending.length) {
    await sb.patch('kmc_campaigns', `id=eq.${id}`, { status: 'completed', updated_at: new Date().toISOString() });
    return { sent: 0, reason: 'completed' };
  }

  const optOuts = new Set((await sb.get('kmc_opt_outs', 'select=phone')).map(r => r.phone));
  let sent = 0, failed = 0, ni = 0;

  for (const contact of pending) {
    if (optOuts.has(contact.phone)) {
      await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { status: 'opted_out' });
      continue;
    }
    const from = KMC_NUMBERS[ni % KMC_NUMBERS.length]; ni++;
    const text = (campaign.message || '')
      .replace(/\{name\}/gi,    contact.first_name || '')
      .replace(/\{address\}/gi, contact.address    || '');

    const r  = await sendSMS(from, contact.phone, text);
    const st = r.ok ? 'sent' : 'failed';

    await Promise.all([
      sb.post('kmc_outbound', { campaign_id: id, from, to: contact.phone, text, status: st, telnyx_id: r.id || null, sent_at: new Date().toISOString() }),
      sb.patch('kmc_contacts', `id=eq.${contact.id}`, { status: st, sent_at: new Date().toISOString(), assigned_from: from }),
    ]);

    if (r.ok) sent++; else failed++;
    await sleep(2100);
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
  const [inbound, outbound] = await Promise.all([
    sb.get('kmc_replies',  'order=timestamp.desc&limit=2000'),
    sb.get('kmc_outbound', 'order=sent_at.desc&limit=2000'),
  ]);

  const m = {};
  for (const r of outbound) {
    if (!r.to) continue;
    if (!m[r.to]) m[r.to] = { phone: r.to, messages: [], lastActivity: '', hasReplied: false, replyType: null };
    m[r.to].messages.push({ dir: 'out', text: r.text, ts: r.sent_at, from: r.from });
    if (r.sent_at > m[r.to].lastActivity) m[r.to].lastActivity = r.sent_at;
  }
  for (const r of inbound) {
    const p = r.from;
    if (!m[p]) m[p] = { phone: p, messages: [], lastActivity: '', hasReplied: true, replyType: r.type };
    m[p].messages.push({ dir: 'in', text: r.text, ts: r.timestamp, type: r.type });
    m[p].hasReplied = true; m[p].replyType = r.type;
    if (r.timestamp > m[p].lastActivity) m[p].lastActivity = r.timestamp;
  }

  const convs = Object.values(m).map(c => {
    c.messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    c.preview = c.messages.at(-1)?.text?.slice(0, 60) || '';
    return c;
  }).sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  res.json(convs);
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
