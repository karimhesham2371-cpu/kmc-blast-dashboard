'use strict';
const express  = require('express');
const multer   = require('multer');
const https    = require('https');
const path     = require('path');
const chrono   = require('chrono-node');

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

// ── Number registry ───────────────────────────────────────────────────────────
// Every Telnyx number on the account, grouped by which brand/audience it was
// bought for. All 26 live on the same messaging profile, whose webhook points
// at this server — so inbound on ANY of them lands here. Campaigns pick their
// own pool via the `numbers` jsonb column; campaigns with no pool set keep the
// original 6 KMC numbers (KMC_NUMBERS) so the existing seller campaign's
// behavior is unchanged.
const NUMBER_GROUPS = [
  { group: 'KMC (sellers)', numbers: {
    '+14702846015': '470-284-6015 · Atlanta GA',
    '+17862289189': '786-228-9189 · Miami FL',
    '+17866386625': '786-638-6625 · Miami FL',
    '+17866642007': '786-664-2007 · Miami FL',
    '+19168850241': '916-885-0241 · Sacramento CA',
    '+17262007337': '726-200-7337 · San Antonio TX',
  }},
  { group: 'LeadMamba (investors)', numbers: {
    '+12144274962': '214-427-4962 · Dallas TX',
    '+17866541780': '786-654-1780 · Miami FL',
    '+16029037610': '602-903-7610 · Phoenix AZ',
    '+17028277529': '702-827-7529 · Las Vegas NV',
    '+16466321375': '646-632-1375 · New York NY',
    '+19176724713': '917-672-4713 · New York NY',
    '+13238311246': '323-831-1246 · Los Angeles CA',
    '+17132609927': '713-260-9927 · Houston TX',
    '+13058468644': '305-846-8644 · Miami FL',
    '+17864359106': '786-435-9106 · Miami FL',
    '+17864359259': '786-435-9259 · Miami FL',
    '+14048356067': '404-835-6067 · Atlanta GA',
    '+16303898954': '630-389-8954 · Chicago IL',
    '+13464809094': '346-480-9094 · Houston TX',
    '+16893564775': '689-356-4775 · Orlando FL',
  }},
  { group: 'Spare', numbers: {
    '+13126752435': '312-675-2435 · Chicago IL',
    '+19163474799': '916-347-4799 · Sacramento CA',
    '+14709320125': '470-932-0125 · Atlanta GA',
    '+17869499467': '786-949-9467 · Miami FL',
    '+12109856004': '210-985-6004 · San Antonio TX',
  }},
];
const KMC_NUMBERS = Object.keys(NUMBER_GROUPS[0].numbers);
const KMC_SET     = new Set(KMC_NUMBERS);
const ALL_NUMBERS = NUMBER_GROUPS.flatMap(g => Object.keys(g.numbers));
const ALL_SET     = new Set(ALL_NUMBERS);

// A campaign's sending pool: its own validated `numbers` list, else the
// legacy default (the 6 KMC numbers).
function campaignNumbers(campaign) {
  const pool = Array.isArray(campaign?.numbers)
    ? campaign.numbers.filter(n => ALL_SET.has(n))
    : [];
  return pool.length ? pool : KMC_NUMBERS;
}

const STOP_RE     = /^(stop|unsubscribe|quit|cancel|end|remove me|opt.?out)[\s.!,]?$/i;

// ── Reply classifier ──────────────────────────────────────────────────────────
// Replaces the old narrow YES_RE / NO_RE pair with a richer tiered function
// that catches motivated-seller replies beyond plain "yes"/"no". Rules are
// evaluated top-to-bottom; first match wins.
//   'yes'   → interested — advance the callback-scheduling flow
//   'no'    → not interested / already sold / hard objection
//   'other' → unclear / hostile / unrelated — no flow action, human reviews
// STOP_RE (true opt-out) is always tested BEFORE this function is called.
function classifyReply(text) {
  const t = (text || '').trim();
  if (!t) return 'other';

  // ── NOT INTERESTED — checked first so they override any sell-intent word ──
  if (/^(no|nope|nah|never|not interested|not selling|never mind|nevermind|stop)[\s.!,?]*$/i.test(t)) return 'no';
  if (/^(sold|it'?s sold|already sold)[\s.!,?🤌]*$/i.test(t)) return 'no';
  if (/\b(already sold|no longer own|don'?t own|just sold|we sold|i sold|i('?ve| have) sold)\b/i.test(t)) return 'no';
  if (/\b(it'?s|it is)\s+(been\s+)?sold\b|\bhas been sold\b|\bbeen sold\b/i.test(t)) return 'no';
  if (/\bunder contract\b|has a contract on it/i.test(t)) return 'no';
  if (/\b(changed my mind|not interested in sell|decided not to sell)\b/i.test(t)) return 'no';
  if (/\bstop\b.{0,10}\bstop\b/i.test(t)) return 'no'; // "stop stop stop"

  // ── INTERESTED ────────────────────────────────────────────────────────────
  // 1. Exact short yes / agreement
  if (/^(yes|y|yep|yeah|yea|sure|interested|definitely|absolutely|ok|okay|sounds good|let'?s go|sign me up|of course|anytime)[\s.!,?]*$/i.test(t)) return 'yes';

  // 2. Explicit sell intent (multi-word phrases)
  if (/\b(interested in sell|want to sell|looking to sell|open to sell|plan(ning)? to sell|going to sell|ready to sell|trying to sell|need(ing)? to sell|hop(e|ing) to sell|would (like|love) to sell|still.{0,20}sell|will be sold|would sell|we('?d| would) sell|i('?d| would) sell)\b/i.test(t)) return 'yes';

  // 3. Bare "Selling" or starts with "Selling" ("Selling market price >")
  if (/^selling\b/i.test(t) && !/\bnot selling\b/i.test(t)) return 'yes';

  // 4. Yes-prefix + neutral body ("yes only for $200k", "yes how much", "yes, who is this?")
  //    Negative guard catches "yes i already sold" etc. — those hit NOT INTERESTED above first.
  if (/^(yes|yeah|yep|yea|sure)\b.{1,80}$/i.test(t) && !/\b(not|never|stop|already sold|no longer|contract|remove|wrong number)\b/i.test(t)) return 'yes';

  // 5. Price anchor — contact quoted a price → signal they want to sell at that figure
  if (/\$\s*\d[\d,.]*\s*[km]?/i.test(t)) return 'yes';  // $400K, $750,000, $200 k
  if (/\b\d{3,4}[km]\b/i.test(t)) return 'yes';          // 215k, 400k, 500k, 395k
  if (/\b\d{1,3}(,\d{3})+\b/.test(t)) return 'yes';      // 750,000 comma-formatted
  if (/\b\d{6,}\b/.test(t)) return 'yes';                 // 750000 no-comma

  // 6. Phone number in body → callback request ("call me direct 770-728-2596")
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(t)) return 'yes';

  // 7. Callback / availability signals
  if (/\bcall me\b|\bcall us\b/i.test(t)) return 'yes';
  if (/\byou can call\b/i.test(t)) return 'yes';
  if (/\bcall in about\b|\bnow is good\b|\bnow works\b/i.test(t)) return 'yes';

  // 8. Asking about the offer
  if (/\bwhat.{0,15}(offer|buy|pay)\b/i.test(t)) return 'yes';
  if (/\bdo you have.{0,10}offer\b/i.test(t)) return 'yes';
  if (/\bhow much.{0,15}(buy|offer|pay|for it)\b/i.test(t)) return 'yes';

  // 9. Timeline engagement with a question ("Next month... where are you located?")
  if (/\b(next month|this month|next week|in \d+\s*(weeks?|months?|days?))\b/i.test(t) && /[?]/.test(t)) return 'yes';

  // 10. Future / conditional interest
  if (/\bnot ready at this time\b/i.test(t)) return 'yes';
  if (/\bwould (like|want|consider).{0,20}sell\b/i.test(t)) return 'yes';

  return 'other';
}

// ── Callback-scheduling flow: message templates (verbatim per spec) ───────────
const MSG_A_TEMPLATE      = "Great! When's a good time to give you a quick call back about {PROPERTY_ADDRESS}?";
const MSG_B_TEMPLATE      = "Perfect, {TIME_ECHO} works 👍 One thing before I call, so I can bring you an actual number instead of wasting your time with 20 questions, mind filling this quick property form? Takes 2 min: {FORM_LINK}. Talk at {TIME_SHORT}!";
const MSG_B_VAGUE_SUFFIX  = "Talk then!";
// Human-feel delay before the auto-reply (Message A) fires after a YES, so it
// doesn't look like an instant bot. The inbound reply is already logged to
// kmc_replies immediately (webhook), so only the outbound Message A waits.
const MSG_A_DELAY_MS      = 2 * 60 * 1000; // 120s
// The optional 4h nudge for AWAITING_CALLBACK_TIME (Step 5.6) — default OFF.
// Flip to true if you want it live; it will never send more than once per
// contact (checked against kmc_outbound history for this exact text).
const NUDGE_ENABLED       = false;
const NUDGE_DELAY_MS      = 4 * 60 * 60 * 1000;
const NUDGE_TEXT          = "No rush, just let me know a good time and I'll call you then 👍";

// ── Email-capture flow (flow_type: 'email_capture') ───────────────────────────
// Investor/wholesaler campaigns: YES → ask for their email → reply containing
// an email → POST it to the pitch-email webhook (Google Apps Script sends the
// branded email from team@leadmamba.com) → confirmation SMS. Per-campaign copy
// lives in kmc_campaigns.flow_config (jsonb): { email_ask: [..variants..],
// email_done: "...", email_webhook: "https://..." } — these are the fallbacks.
const EMAIL_ASK_DEFAULTS = [
  "We're only working with a handful of investors right now — drop your email and I'll get you the info asap.",
  "Perfect! I've got something I think you'll really like. What email can I reach you at?",
];
const EMAIL_DONE_DEFAULT = "Just sent it over 👍 Check your inbox (worth a peek at spam/promotions too). Any questions, just text me here.";
const EMAIL_PITCH_WEBHOOK_DEFAULT = 'https://script.google.com/macros/s/AKfycbxxmtnHLJq1JzeRGBtTMslWLnPqiBWmqsmGoLkUF7Cf5xymDC-oLcBnfV_qHK_vA5fc/exec';
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function emailAskVariants(campaign) {
  const cfg = campaign?.flow_config;
  const asks = Array.isArray(cfg?.email_ask) ? cfg.email_ask.filter(v => typeof v === 'string' && v.trim()) : [];
  return asks.length ? asks : EMAIL_ASK_DEFAULTS;
}

// Classify an investor's reply into one of the three buyer types the user
// cares about. Order matters — checked most-specific first so a reply that
// mentions more than one term resolves to the more distinctive identity
// (a "wholesaler" who also "buys cash" is tagged wholesaler). Returns
// 'wholesaler' | 'cash_buyer' | 'investor' | null (no clear signal).
function detectBuyerType(text) {
  const t = (text || '').toLowerCase();
  if (/\bwholesal/i.test(t)) return 'wholesaler';                              // wholesale, wholesaler, wholesaling
  if (/\b(flip|flipp|fix and flip|fix & flip|rehab|buy and hold|buy & hold|landlord|rental|investor|investing|\binvest\b|\bportfolio\b)/i.test(t)) return 'investor';
  if (/\bcash\b|\bcash buyer\b|pay cash|\bbuyer\b|\bi buy\b|\bwe buy\b|\bbuying\b/i.test(t)) return 'cash_buyer';
  return null;
}
const BUYER_TYPES = ['cash_buyer', 'wholesaler', 'investor'];

// Detects automated replies (business autoresponders / bots) so the flow never
// treats them as a real answer — otherwise our auto-reply triggers THEIR
// autoresponder, which triggers ours again, looping. These are common on
// business landlines in a cold list ("Your message has been received by X",
// "Paul has read your message", Podium/CRM auto-texts).
const AUTORESPONDER_RE = /\b(has been received|has read your message|thank you for contacting|thanks for (texting|contacting|reaching)|out of office|automated (response|reply|message)|auto[- ]?reply|no longer (in service|available)|will (get|be) back|we('| a)?ll be with you|save (our|my) contact info|do not reply|this (is an|number is)( an)? automated|received your (message|text))\b/i;
function isAutoresponder(text) {
  return AUTORESPONDER_RE.test(text || '');
}

// POST {phone, email, name} to the Apps Script that sends the pitch email.
// Apps Script answers a POST with a 302 to a one-time googleusercontent URL —
// fetch follows it automatically (redirect: 'follow' is the default).
async function postPitchEmail(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    console.error('[PitchEmail] webhook call failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Supabase ──────────────────────────────────────────────────────────────────
function sbReq(method, table, body, qs, range) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = {
      apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json', Accept: 'application/json',
    };
    if (method === 'POST')  h.Prefer = 'resolution=ignore-duplicates,return=representation';
    if (method === 'PATCH') h.Prefer = 'return=representation';
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    if (range) { h['Range-Unit'] = 'items'; h.Range = range; }
    const req = https.request({
      hostname: SB_HOST,
      path: `/rest/v1/${table}${qs ? '?' + qs : ''}`,
      method, headers: h,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, data: d ? JSON.parse(d) : null, headers: res.headers }); }
        catch { resolve({ ok: false, status: res.statusCode, data: d, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Supabase/PostgREST on this project enforces a hard 1000-row cap per request
// regardless of any `limit=` query param — confirmed by testing directly against
// the API (limit=20000 still returned Content-Range: 0-999/*). This silently
// truncated the Inbox (outbound history), cross-campaign dedup checks, and
// campaign contact counts on any table that grew past 1000 rows, with no error
// surfaced anywhere. getAll() pages through with explicit Range headers in
// 1000-row chunks until a short page confirms there's nothing left, so callers
// that need the FULL table (dedup checks, counts, inbox history) always get it.
const PAGE_SIZE = 1000;
async function sbGetAll(table, qs) {
  let start = 0, all = [];
  for (;;) {
    const end = start + PAGE_SIZE - 1;
    const r = await sbReq('GET', table, null, qs, `${start}-${end}`);
    const page = Array.isArray(r.data) ? r.data : [];
    all = all.concat(page);
    if (page.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }
  return all;
}
// Same as getAll, but stops once `wanted` rows are collected — for callers that
// need an exact, possibly-large N (e.g. pulling `cap` pending contacts for a
// blast where cap could exceed 1000) without over-fetching the whole table.
async function sbGetUpTo(table, qs, wanted) {
  let start = 0, all = [];
  while (all.length < wanted) {
    const end = start + PAGE_SIZE - 1;
    const r = await sbReq('GET', table, null, qs, `${start}-${end}`);
    const page = Array.isArray(r.data) ? r.data : [];
    all = all.concat(page);
    if (page.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }
  return all.slice(0, wanted);
}

const sb = {
  get:     (t, qs)        => sbReq('GET',    t, null, qs).then(r => Array.isArray(r.data) ? r.data : []),
  getAll:  (t, qs)        => sbGetAll(t, qs),
  getUpTo: (t, qs, n)     => sbGetUpTo(t, qs, n),
  post:    (t, rows)      => sbReq('POST',   t, Array.isArray(rows) ? rows : [rows]),
  patch:   (t, qs, b)     => sbReq('PATCH',  t, b, qs),
  del:     (t, qs)        => sbReq('DELETE', t, null, qs),
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
        try {
          const j = JSON.parse(d);
          const errDetail = j?.errors?.map(e => e.detail || e.title).join('; ');
          if (errDetail) console.error(`[Telnyx ${res.statusCode}] from:${from} to:${to} → ${errDetail}`);
          resolve({ ok: res.statusCode === 200, id: j?.data?.id, status: res.statusCode, errDetail });
        }
        catch { console.error(`[Telnyx ${res.statusCode}] from:${from} to:${to} → unparseable body: ${d.slice(0,200)}`); resolve({ ok: false, status: res.statusCode }); }
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
  const [campaigns, optOuts, declines, replies, sentToday] = await Promise.all([
    sb.get('kmc_campaigns', 'select=id,status,total_contacts,sent_today'),
    sb.getAll('kmc_opt_outs',  'select=phone'),
    sb.getAll('kmc_declines',  'select=phone'),
    sb.getAll('kmc_replies',   'select=type'),
    sb.getAll('kmc_outbound',  `select=id&sent_at=gte.${today}T00:00:00Z`),
  ]);
  res.json({
    campaigns:      campaigns.length,
    active:         campaigns.filter(c => c.status === 'active').length,
    total_contacts: campaigns.reduce((a, c) => a + (c.total_contacts || 0), 0),
    opt_outs:       optOuts.length,
    declines:       declines.length,
    sent_today:     sentToday.length,
    total_replies:  replies.length,
    yes_replies:    replies.filter(r => r.type === 'yes').length,
    no_replies:     replies.filter(r => r.type === 'no').length,
    other_replies:  replies.filter(r => r.type === 'other').length,
  });
});

// Number pool for the frontend (campaign number pickers, reply-from selects)
app.get('/api/numbers', auth, (req, res) => {
  res.json(NUMBER_GROUPS.map(g => ({
    group: g.group,
    numbers: Object.entries(g.numbers).map(([number, label]) => ({ number, label })),
  })));
});

// Validate/normalize the per-campaign fields shared by POST and PATCH.
// Returns {error} or {values} containing only the keys that were present.
function sanitizeCampaignExtras(body) {
  const values = {};
  if ('flow_type' in body) {
    if (!['callback', 'email_capture'].includes(body.flow_type)) return { error: 'flow_type must be callback or email_capture' };
    values.flow_type = body.flow_type;
  }
  if ('numbers' in body) {
    if (body.numbers != null && !Array.isArray(body.numbers)) return { error: 'numbers must be an array' };
    const pool = (body.numbers || []).filter(n => ALL_SET.has(n));
    if (body.numbers && body.numbers.length && !pool.length) return { error: 'none of those numbers exist on this account' };
    values.numbers = pool.length ? [...new Set(pool)] : null;
  }
  if ('flow_config' in body) {
    const cfg = body.flow_config;
    if (cfg != null && (typeof cfg !== 'object' || Array.isArray(cfg))) return { error: 'flow_config must be an object' };
    if (cfg == null) { values.flow_config = null; }
    else {
      const clean = {};
      if (Array.isArray(cfg.email_ask)) {
        const asks = cfg.email_ask.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
        if (asks.length) clean.email_ask = asks.slice(0, 3);
      }
      if (typeof cfg.email_done === 'string' && cfg.email_done.trim()) clean.email_done = cfg.email_done.trim();
      if (typeof cfg.email_webhook === 'string' && cfg.email_webhook.trim()) {
        if (!/^https:\/\//i.test(cfg.email_webhook.trim())) return { error: 'email_webhook must be an https:// URL' };
        clean.email_webhook = cfg.email_webhook.trim();
      }
      values.flow_config = Object.keys(clean).length ? clean : null;
    }
  }
  return { values };
}

// Campaigns
app.get('/api/campaigns', auth, async (req, res) => {
  res.json(await sb.get('kmc_campaigns', 'order=created_at.desc'));
});

app.post('/api/campaigns', auth, async (req, res) => {
  const { name, daily_limit, message, message_2, message_3, auto_reply_enabled, auto_reply_message, quiet_hours_enabled, form_link } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  const extras = sanitizeCampaignExtras(req.body);
  if (extras.error) return res.status(400).json({ error: extras.error });
  const r = await sb.post('kmc_campaigns', {
    name, daily_limit: daily_limit || 200, message,
    message_2: message_2 || null, message_3: message_3 || null,
    auto_reply_enabled: !!auto_reply_enabled, auto_reply_message: auto_reply_message || null,
    quiet_hours_enabled: !!quiet_hours_enabled, form_link: form_link || null,
    flow_type: 'callback', numbers: null, flow_config: null,
    ...extras.values,
    status: 'draft', sent_today: 0, total_contacts: 0, last_sent_date: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  // Surface DB write failures instead of masking them as success. On a
  // PostgREST error, r.data is the error OBJECT (no [0]), so the old
  // `r.data?.[0] || {ok:r.ok}` returned HTTP 200 {ok:false} with no `error`
  // key — the UI then showed "Campaign created ✓" on a failed write.
  if (!r.ok) { console.error('[Campaigns] create failed:', r.status, JSON.stringify(r.data)); return res.status(500).json({ error: r.data?.message || r.data?.hint || `DB write failed (HTTP ${r.status})` }); }
  res.json(r.data?.[0] || { ok: r.ok });
});

app.patch('/api/campaigns/:id', auth, async (req, res) => {
  const extras = sanitizeCampaignExtras(req.body);
  if (extras.error) return res.status(400).json({ error: extras.error });
  const r = await sb.patch('kmc_campaigns', `id=eq.${req.params.id}`, {
    ...req.body, ...extras.values, updated_at: new Date().toISOString(),
  });
  if (!r.ok) { console.error('[Campaigns] update failed:', r.status, JSON.stringify(r.data)); return res.status(500).json({ error: r.data?.message || r.data?.hint || `DB write failed (HTTP ${r.status})` }); }
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
    sb.getAll('kmc_contacts', `campaign_id=eq.${id}&select=id`),
    sb.getAll('kmc_contacts', `campaign_id=eq.${id}&status=eq.pending&select=id`),
    sb.getAll('kmc_contacts', `campaign_id=eq.${id}&status=eq.sent&select=id`),
    sb.getAll('kmc_contacts', `campaign_id=eq.${id}&status=eq.failed&select=id`),
    sb.getAll('kmc_contacts', `campaign_id=eq.${id}&status=eq.opted_out&select=id`),
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

  const [optOutRows, declineRows, thisCampRows, otherCampRows, outboundRows] = await Promise.all([
    sb.getAll('kmc_opt_outs',  'select=phone'),
    sb.getAll('kmc_declines',  'select=phone'),
    sb.getAll('kmc_contacts',  `campaign_id=eq.${id}&select=phone`),
    sb.getAll('kmc_contacts',  `campaign_id=neq.${id}&select=phone,status`),
    sb.getAll('kmc_outbound',  'select=to'),
  ]);
  const optOuts  = new Set(optOutRows.map(r => r.phone));
  const declines = new Set(declineRows.map(r => r.phone));
  const existing = new Set(thisCampRows.map(r => r.phone));
  // Cross-campaign safety net: anyone already in another campaign (queued or already sent),
  // or with any outbound send history at all, gets skipped so we never double-text a lead
  // just because they were uploaded into more than one list.
  const alreadyContacted = new Set([
    ...otherCampRows.map(r => r.phone),
    ...outboundRows.map(r => r.to),
  ]);
  const batch = []; let invalid = 0, dupes = 0, blocked = 0, declined = 0, crossCampaign = 0;

  // Create the list record up front so every inserted contact is tagged with
  // list_id — this lets us show "which CSVs are loaded" and delete a whole
  // list in one operation without hunting by filename.
  const listRow = await sb.post('kmc_contact_lists', {
    campaign_id: parseInt(id),
    filename: req.file.originalname || 'upload.csv',
    total_contacts: 0, // updated to actual inserted count after the insert loop
    created_at: new Date().toISOString(),
  });
  const listId = listRow.data?.[0]?.id || null;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p   = parseCSVLine(lines[i]);
    const raw = (p[phoneIdx] || '').replace(/\D/g, '');
    if (raw.length < 10) { invalid++; continue; }
    const phone = '+1' + raw.slice(-10);
    if (optOuts.has(phone))         { blocked++; continue; }
    if (declines.has(phone))        { declined++; continue; }
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
      list_id: listId,
      created_at: new Date().toISOString(),
    });
  }

  let inserted = 0;
  for (let i = 0; i < batch.length; i += 100) {
    const r = await sb.post('kmc_contacts', batch.slice(i, i + 100));
    if (r.ok && r.data) inserted += r.data.length;
  }

  const total = (await sb.getAll('kmc_contacts', `campaign_id=eq.${id}&select=id`)).length;
  // If the campaign was 'completed' and we just added new contacts, reset it to
  // 'paused' so Activate / Blast Now buttons reappear automatically.
  const campNow = await sb.get('kmc_campaigns', `id=eq.${id}&select=status`);
  const resetStatus = inserted > 0 && campNow[0]?.status === 'completed' ? { status: 'paused' } : {};
  await sb.patch('kmc_campaigns', `id=eq.${id}`, { total_contacts: total, ...resetStatus, updated_at: new Date().toISOString() });
  // Update the list record with the actual inserted count
  if (listId) await sb.patch('kmc_contact_lists', `id=eq.${listId}`, { total_contacts: inserted });
  res.json({ inserted, dupes, blocked, declined, invalid, crossCampaign, total_in_campaign: total });
});

// ── Contact Lists ─────────────────────────────────────────────────────────────
// Each CSV upload creates one kmc_contact_lists record and tags every contact
// row with that list_id. This lets the dashboard show which files are loaded,
// how many contacts each contributed, and allows deleting a whole batch at once
// without resetting opted-out or actively-flowing contacts.

app.get('/api/campaigns/:id/lists', auth, async (req, res) => {
  const [lists, untagged] = await Promise.all([
    sb.getAll('kmc_contact_lists', `campaign_id=eq.${req.params.id}&order=created_at.desc`),
    sb.getAll('kmc_contacts', `campaign_id=eq.${req.params.id}&list_id=is.null&select=id`),
  ]);
  // Contacts uploaded before list-tracking was added have list_id=null and no
  // kmc_contact_lists record. Surface them as a synthetic entry so they're
  // visible and deletable from the UI, same as any tracked list.
  const result = [...lists];
  if (untagged.length > 0) {
    result.push({ id: null, filename: '(contacts uploaded before list tracking)', total_contacts: untagged.length, created_at: null, legacy: true });
  }
  res.json(result);
});

app.delete('/api/campaigns/:id/lists/:listId', auth, async (req, res) => {
  const { id, listId } = req.params;

  // Pull contacts tagged to this specific list
  const listContacts = await sb.getAll('kmc_contacts',
    `list_id=eq.${listId}&campaign_id=eq.${id}&select=id,phone,status,flow_state`
  );

  // Preserve opted-out contacts (their kmc_opt_outs entry is the real guard,
  // but keeping the row lets the UI show them as opted_out still) and anyone
  // in an active conversation — deleting mid-flow would strand them.
  const KEEP_FLOW = new Set(['AWAITING_CALLBACK_TIME', 'CALL_SCHEDULED', 'AWAITING_EMAIL', 'EMAIL_CAPTURED']);
  const toDelete = listContacts.filter(c =>
    c.status !== 'opted_out' && !KEEP_FLOW.has(c.flow_state)
  );
  const skipped = listContacts.length - toDelete.length;

  for (let i = 0; i < toDelete.length; i += 100) {
    const chunk = toDelete.slice(i, i + 100);
    await sb.del('kmc_contacts', `id=in.(${chunk.map(c => c.id).join(',')})`);
  }

  // Remove the list record itself
  await sb.del('kmc_contact_lists', `id=eq.${listId}`);

  // Sync campaign contact count
  const remaining = await sb.getAll('kmc_contacts', `campaign_id=eq.${id}&select=id`);
  await sb.patch('kmc_campaigns', `id=eq.${id}`, {
    total_contacts: remaining.length, updated_at: new Date().toISOString(),
  });

  console.log(`[DeleteList] list ${listId} — deleted ${toDelete.length}, skipped ${skipped} (opted-out or in-flow)`);
  res.json({ ok: true, deleted: toDelete.length, skipped, remaining: remaining.length });
});

// Delete contacts that predate list-tracking (list_id IS NULL) for a campaign
app.delete('/api/campaigns/:id/lists/legacy', auth, async (req, res) => {
  const { id } = req.params;
  const legacyContacts = await sb.getAll('kmc_contacts',
    `campaign_id=eq.${id}&list_id=is.null&select=id,phone,status,flow_state`
  );
  const KEEP_FLOW = new Set(['AWAITING_CALLBACK_TIME', 'CALL_SCHEDULED', 'AWAITING_EMAIL', 'EMAIL_CAPTURED']);
  const toDelete = legacyContacts.filter(c => c.status !== 'opted_out' && !KEEP_FLOW.has(c.flow_state));
  const skipped  = legacyContacts.length - toDelete.length;
  for (let i = 0; i < toDelete.length; i += 100) {
    const chunk = toDelete.slice(i, i + 100);
    await sb.del('kmc_contacts', `id=in.(${chunk.map(c => c.id).join(',')})`);
  }
  const remaining = await sb.getAll('kmc_contacts', `campaign_id=eq.${id}&select=id`);
  await sb.patch('kmc_campaigns', `id=eq.${id}`, { total_contacts: remaining.length, updated_at: new Date().toISOString() });
  console.log(`[DeleteLegacy] campaign ${id} — deleted ${toDelete.length}, skipped ${skipped}`);
  res.json({ ok: true, deleted: toDelete.length, skipped, remaining: remaining.length });
});

app.get('/api/campaigns/:id/contacts', auth, async (req, res) => {
  const { status, limit = 200, offset = 0 } = req.query;
  let qs = `campaign_id=eq.${req.params.id}&order=created_at.asc&limit=${limit}&offset=${offset}`;
  if (status) qs += `&status=eq.${status}`;
  res.json(await sb.get('kmc_contacts', qs));
});

// Activate / Pause
app.post('/api/campaigns/:id/activate', auth, async (req, res) => {
  if (!isWithinSendWindow()) return res.status(403).json({ error: sendWindowBlockedMessage() });
  await sb.patch('kmc_campaigns', `id=eq.${req.params.id}`, { status: 'active', updated_at: new Date().toISOString() });
  res.json({ ok: true });
});
app.post('/api/campaigns/:id/pause', auth, async (req, res) => {
  await sb.patch('kmc_campaigns', `id=eq.${req.params.id}`, { status: 'paused', updated_at: new Date().toISOString() });
  res.json({ ok: true });
});

// ── Global send-window guard ───────────────────────────────────────────────────
// HARD, non-bypassable rule — independent of any per-campaign "quiet hours" toggle.
// Render's server clock runs in UTC, so the hour is always computed explicitly in
// America/New_York (handles EST/EDT automatically) rather than relying on server-local time.
// This exists specifically to prevent a repeat of the incident where a timezone bug let a
// campaign start blasting at ~5am Eastern. Do not make this optional or campaign-configurable.
const SEND_TIMEZONE    = 'America/New_York';
const SEND_WINDOW_START = 9;  // 9:00 AM Eastern
const SEND_WINDOW_END   = 18; // 6:00 PM Eastern (blast must stop sending at/after this hour)

function easternHour() {
  return parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: SEND_TIMEZONE }).format(new Date()));
}
function easternTimeLabel() {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: SEND_TIMEZONE }).format(new Date()) + ' ET';
}
function isWithinSendWindow() {
  const hr = easternHour();
  return hr >= SEND_WINDOW_START && hr < SEND_WINDOW_END;
}
function sendWindowBlockedMessage() {
  return `Sending is restricted to 9:00 AM – 6:00 PM Eastern to prevent off-hours texting. It is currently ${easternTimeLabel()}. Please try again within the allowed window.`;
}

// In-flight lock — prevents two overlapping runBlast() calls for the same campaign
// (e.g. the 10-min auto-loop firing while a manual "Blast Now" is still mid-send)
// from each reading the same stale sent_today and both independently blasting up to
// the full daily cap, doubling the actual volume sent. This was the root cause of a
// campaign with daily_limit:400 sending 602 messages in one day.
const blastingCampaigns = new Set();

async function runBlast(campaign) {
  const id = campaign.id;
  if (blastingCampaigns.has(id)) {
    console.log(`[Blast] "${campaign.name}" skipped — already in progress`);
    return { sent: 0, reason: 'blast already in progress' };
  }
  blastingCampaigns.add(id);
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const sentSoFar = campaign.last_sent_date === today ? (campaign.sent_today || 0) : 0;
    const cap       = (campaign.daily_limit || 200) - sentSoFar;
    if (cap <= 0) return { sent: 0, reason: 'daily limit reached' };

    // Hard guard — always enforced, regardless of campaign.quiet_hours_enabled
    if (!isWithinSendWindow()) {
      return { sent: 0, reason: sendWindowBlockedMessage() };
    }

    const pending = await sb.getUpTo('kmc_contacts', `campaign_id=eq.${id}&status=eq.pending&order=created_at.asc`, cap);
    if (!pending.length) {
      await sb.patch('kmc_campaigns', `id=eq.${id}`, { status: 'completed', updated_at: new Date().toISOString() });
      return { sent: 0, reason: 'completed' };
    }

    // Build the pool of available message variants (1-3), rotated round-robin per contact
    const variants = [campaign.message, campaign.message_2, campaign.message_3].filter(v => v && v.trim());

    const optOuts = new Set((await sb.getAll('kmc_opt_outs', 'select=phone')).map(r => r.phone));
    let sent = 0, failed = 0, ni = 0;

    for (const contact of pending) {
      // Re-check the send window on every iteration too, in case a long-running blast
      // crosses the 6pm ET cutoff mid-run.
      if (!isWithinSendWindow()) break;

      if (optOuts.has(contact.phone)) {
        await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { status: 'opted_out' });
        continue;
      }
      const pool = campaignNumbers(campaign);
      const from = pool[ni % pool.length];
      const variantIdx = ni % variants.length;
      const template = variants[variantIdx];
      ni++;
      const text = (template || '')
        .replace(/\{name\}/gi,    contact.first_name || '')
        // {state} is an alias for the address field — for phone+state-only
        // investor lists, the uploaded "state" lands in contact.address, so
        // {state} lets those templates read naturally ("...in {state}?").
        .replace(/\{state\}/gi,   contact.address    || '')
        .replace(/\{address\}/gi, contact.address    || '');

      const r  = await sendSMS(from, contact.phone, text);
      const st = r.ok ? 'sent' : 'failed';

      await Promise.all([
        sb.post('kmc_outbound', { campaign_id: id, from, to: contact.phone, text, status: st, telnyx_id: r.id || null, sent_at: new Date().toISOString() }),
        sb.patch('kmc_contacts', `id=eq.${contact.id}`, { status: st, sent_at: new Date().toISOString(), assigned_from: from, message_variant: variantIdx + 1 }),
      ]);

      if (r.ok) sent++; else failed++;
      // Persist sent_today after every message (not just at the end) so the cap
      // reflects live progress even if the process restarts or crashes mid-blast.
      await sb.patch('kmc_campaigns', `id=eq.${id}`, {
        sent_today: sentSoFar + sent, last_sent_date: today, updated_at: new Date().toISOString(),
      });
      // Human-like jitter: 1.8s-2.8s between sends instead of a fixed robotic cadence
      await sleep(1800 + Math.floor(Math.random() * 1000));
    }

    console.log(`[Blast] "${campaign.name}" → sent:${sent} failed:${failed}`);
    return { sent, failed };
  } finally {
    blastingCampaigns.delete(id);
  }
}

app.post('/api/campaigns/:id/blast', auth, async (req, res) => {
  if (!isWithinSendWindow()) return res.status(403).json({ error: sendWindowBlockedMessage() });
  const campaigns = await sb.get('kmc_campaigns', `id=eq.${req.params.id}`);
  if (!campaigns.length) return res.status(404).json({ error: 'Not found' });
  const c = campaigns[0];
  if (c.status === 'completed') return res.json({ ok: false, message: 'Campaign already completed' });

  const today   = new Date().toISOString().slice(0, 10);
  const soFar   = c.last_sent_date === today ? (c.sent_today || 0) : 0;
  const cap     = (c.daily_limit || 200) - soFar;
  const pending = await sb.getAll('kmc_contacts', `campaign_id=eq.${req.params.id}&status=eq.pending&select=id`);

  res.json({ ok: true, queued: Math.min(pending.length, Math.max(0, cap)), cap, pending: pending.length });
  setImmediate(() => runBlast(c));
});

// Inbox
// Optional ?days=N restricts to conversations with activity in the last N days —
// keeps the (now correctly-uncapped) full-history fetch fast for routine polling
// instead of re-pulling every message ever sent on every 10s auto-refresh.
app.get('/api/inbox', auth, async (req, res) => {
  const days = parseInt(req.query.days);
  const sinceISO = (days > 0) ? new Date(Date.now() - days * 86400000).toISOString() : null;

  // Optional ?campaign_id=N — a DEDICATED inbox for one campaign: only pull
  // that campaign's messages instead of the whole table. Campaigns use
  // distinct number pools, so a message belongs to a campaign iff it was
  // sent-from / received-on one of that campaign's numbers. This is what makes
  // a big single campaign's inbox fast (KMC alone is thousands of convs).
  const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id) : null;
  let poolInbound = '', poolOutbound = '';
  if (campaignId) {
    const camps = await sb.get('kmc_campaigns', `id=eq.${campaignId}`);
    if (camps[0]) {
      const enc = campaignNumbers(camps[0]).map(encodeURIComponent).join(',');
      poolInbound  = `&to=in.(${enc})`;   // inbound replies landed ON these numbers
      poolOutbound = `&from=in.(${enc})`; // outbound was sent FROM these numbers
    }
  }

  const inboundQs  = 'order=timestamp.desc' + (sinceISO ? `&timestamp=gte.${sinceISO}` : '') + poolInbound;
  const outboundQs = 'order=sent_at.desc'   + (sinceISO ? `&sent_at=gte.${sinceISO}`   : '') + poolOutbound;

  const [inbound, outbound, campaignRows] = await Promise.all([
    sb.getAll('kmc_replies',  inboundQs),
    sb.getAll('kmc_outbound', outboundQs),
    sb.get('kmc_campaigns', 'select=id,name'),
  ]);
  const campaignNameById = {};
  for (const c of campaignRows) campaignNameById[c.id] = c.name;

  // Only look up contacts for phones that actually appear in the messages we
  // just fetched — pulling the ENTIRE kmc_contacts table (every lead ever
  // uploaded across every campaign, paginated 1000 rows at a time) on every
  // single Inbox load/poll was the real cause of the "have to wait ~a minute"
  // slowness; that full-table fetch ignored the days filter entirely and grew
  // with the size of the whole leads database, not the size of the Inbox view.
  const phoneSet = new Set();
  for (const r of inbound)  if (r.from) phoneSet.add(r.from);
  for (const r of outbound) if (r.to)   phoneSet.add(r.to);
  const phones = [...phoneSet];

  const CHUNK = 200; // keep each PostgREST `in.()` filter URL a safe length
  const chunks = [];
  for (let i = 0; i < phones.length; i += CHUNK) chunks.push(phones.slice(i, i + CHUNK));
  const contactChunks = await Promise.all(chunks.map(chunk =>
    sb.getAll('kmc_contacts', `select=phone,first_name,campaign_id,flow_state,scheduled_call_time_utc,needs_human,needs_human_reason,email,buyer_type&phone=in.(${chunk.map(encodeURIComponent).join(',')})&order=created_at.desc`)
  ));
  const contacts = contactChunks.flat();

  // Build phone → name lookup (most recently-created contact record wins if a phone appears more than once)
  const contactByPhone = {};
  for (const c of contacts) {
    if (!c.phone || contactByPhone[c.phone]) continue;
    contactByPhone[c.phone] = {
      name: (c.first_name || '').trim(),
      campaignId: c.campaign_id || null,
      flowState: c.flow_state || null, scheduledCallTimeUtc: c.scheduled_call_time_utc || null,
      needsHuman: !!c.needs_human, needsHumanReason: c.needs_human_reason || null,
      email: c.email || null, buyerType: c.buyer_type || null,
    };
  }

  const m = {};
  for (const r of outbound) {
    if (!r.to) continue;
    if (!m[r.to]) m[r.to] = { phone: r.to, messages: [], lastActivity: '', hasReplied: false, replyType: null, lastInboundTs: null, outboundCampaignId: null, lastOutboundTs: null };
    m[r.to].messages.push({ id: r.id, dir: 'out', text: r.text, ts: r.sent_at, from: r.from });
    // Track the most-recent non-null campaign_id from this conversation's
    // outbound messages — the fallback campaign attribution when the contact
    // row has no campaign_id (orphans) or was deleted.
    if (r.campaign_id != null && (!m[r.to].lastOutboundTs || r.sent_at > m[r.to].lastOutboundTs)) {
      m[r.to].lastOutboundTs = r.sent_at;
      m[r.to].outboundCampaignId = r.campaign_id;
    }
    if (r.sent_at > m[r.to].lastActivity) m[r.to].lastActivity = r.sent_at;
  }
  for (const r of inbound) {
    const p = r.from;
    if (!m[p]) m[p] = { phone: p, messages: [], lastActivity: '', hasReplied: false, replyType: null, lastInboundTs: null, outboundCampaignId: null, lastOutboundTs: null };
    m[p].messages.push({ id: r.id, dir: 'in', text: r.text, ts: r.timestamp, type: r.type, to: r.to });
    m[p].hasReplied = true;
    // The conversation's classification (yes/no/other) must reflect the MOST
    // RECENT inbound message, not just whichever one this loop happens to
    // process last — sb.getAll() pages don't guarantee processing order lines
    // up with `timestamp.desc`, so track explicitly by comparing timestamps.
    if (!m[p].lastInboundTs || r.timestamp > m[p].lastInboundTs) {
      m[p].lastInboundTs = r.timestamp;
      m[p].replyType = r.type;
    }
    if (r.timestamp > m[p].lastActivity) m[p].lastActivity = r.timestamp;
  }

  const convs = Object.values(m).map(c => {
    c.messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    c.preview = c.messages.at(-1)?.text?.slice(0, 60) || '';
    const contact = contactByPhone[c.phone];
    c.name = contact?.name || '';
    c.flowState = contact?.flowState || null;
    c.scheduledCallTimeUtc = contact?.scheduledCallTimeUtc || null;
    c.needsHuman = contact?.needsHuman || false;
    c.needsHumanReason = contact?.needsHumanReason || null;
    c.email = contact?.email || null;
    c.buyerType = contact?.buyerType || null;
    // Campaign attribution: prefer the contact's campaign; fall back to the
    // campaign that actually sent the outbound blast/auto-replies (covers
    // orphan contacts and deleted contact rows). null = unassigned (manual-only).
    c.campaignId = contact?.campaignId ?? c.outboundCampaignId ?? null;
    c.campaignName = c.campaignId != null ? (campaignNameById[c.campaignId] || null) : null;
    delete c.lastInboundTs;
    delete c.outboundCampaignId;
    delete c.lastOutboundTs;
    return c;
  }).sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  res.json(convs);
});

// Test send — preview any of the 3 variants (or auto-reply) to a single number, no contact/campaign side-effects
app.post('/api/campaigns/:id/test-send', auth, async (req, res) => {
  const { to, variant } = req.body; // variant: 1, 2, or 3 — the message rotation variants only
  if (!to) return res.status(400).json({ error: 'to required' });
  if (variant === 'auto_reply') return res.status(400).json({ error: 'Legacy auto-reply test-send has been removed — it was a source of wrong-campaign message mix-ups. Use the reply box in the Inbox for manual sends.' });
  const campaigns = await sb.get('kmc_campaigns', `id=eq.${req.params.id}`);
  const c = campaigns[0];
  if (!c) return res.status(404).json({ error: 'Not found' });
  const raw = to.replace(/\D/g, '');
  const phone = '+1' + raw.slice(-10);
  let template;
  if (variant == 2) template = c.message_2;
  else if (variant == 3) template = c.message_3;
  else template = c.message;
  if (!template?.trim()) return res.status(400).json({ error: 'That variant is empty' });
  const text = template.replace(/\{name\}/gi, 'Test').replace(/\{state\}/gi, 'Texas').replace(/\{address\}/gi, '123 Sample St');
  const r = await sendSMS(campaignNumbers(c)[0], phone, `[TEST] ${text}`);
  console.log(`[TestSend] ${r.ok ? 'sent' : 'FAILED'} variant=${variant} — "${c.name}" → ${phone}`);
  res.json({ ok: r.ok, id: r.id, status: r.status, text });
});

// Manual send — used by the Inbox reply box. Always operator-typed text sent
// to exactly the phone number shown on screen; no longer has any path that
// pulls in a campaign's saved auto-reply text (that mechanism was removed
// after it was found to occasionally attribute the wrong campaign's saved
// text to a contact when the same phone existed in more than one campaign).
app.post('/api/send', auth, async (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || !text) return res.status(400).json({ error: 'from, to, text required' });
  if (!ALL_SET.has(from))   return res.status(400).json({ error: 'Invalid from number' });
  const optOut = await sb.get('kmc_opt_outs', `phone=eq.${encodeURIComponent(to)}`);
  if (optOut.length) return res.status(400).json({ error: 'Number has opted out' });
  const r = await sendSMS(from, to, text);
  console.log(`[Manual] ${r.ok ? 'sent' : 'FAILED'} ${from} → ${to} | "${text.slice(0, 60)}"`);
  if (r.ok) {
    await sb.post('kmc_outbound', { campaign_id: null, from, to, text, status: 'sent', telnyx_id: r.id || null, sent_at: new Date().toISOString() });
  }
  else await sb.post('kmc_outbound', { campaign_id: null, from, to, text, status: 'failed', telnyx_id: r.id || null, sent_at: new Date().toISOString() });
  res.json({ ok: r.ok, id: r.id, status: r.status, error: r.ok ? undefined : (r.errDetail || `Telnyx rejected the message (HTTP ${r.status})`) });
});

// Delete a single message (inbound from kmc_replies, outbound from kmc_outbound)
app.delete('/api/messages/:id', auth, async (req, res) => {
  const { dir } = req.query; // 'in' or 'out'
  const table = dir === 'out' ? 'kmc_outbound' : 'kmc_replies';
  await sb.del(table, `id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// Diagnostic: replay the exact lookup advanceFlow() (the live YES-reply flow,
// server.js's `sb.get('kmc_contacts', ...&order=created_at.desc&limit=1)`)
// does for a phone number, without touching the DB by hand. Shows every
// kmc_contacts row for this phone (a phone can appear in more than one
// campaign), which one the flow's `limit=1` lookup would actually pick (most
// recently created), and that record's campaign/auto_replied state. This is
// the tool to use if a contact's messages look like they belong to the wrong
// campaign — that always means the same phone has more than one contact row.
app.get('/api/debug/auto-reply/:phone', auth, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const contacts = await sb.getAll('kmc_contacts', `phone=eq.${encodeURIComponent(phone)}&order=created_at.desc`);
  const campIds = [...new Set(contacts.map(c => c.campaign_id).filter(Boolean))];
  const camps = {};
  for (const id of campIds) {
    const rows = await sb.get('kmc_campaigns', `id=eq.${id}`);
    camps[id] = rows[0] || null;
  }
  const records = contacts.map((c, i) => {
    const camp = c.campaign_id ? camps[c.campaign_id] : null;
    const reasons = [];
    if (!c.campaign_id) reasons.push('contact has no campaign_id');
    if (c.campaign_id && !camp) reasons.push('campaign_id points to a campaign that no longer exists');
    if (camp && !camp.auto_reply_enabled) reasons.push('campaign auto-reply is OFF');
    if (camp && camp.auto_reply_enabled && !camp.auto_reply_message?.trim()) reasons.push('campaign auto-reply message is empty');
    if (c.auto_replied) reasons.push('auto_replied already true on this contact row — auto-reply already sent once and will not resend');
    return {
      wouldBePickedByWebhook: i === 0, // webhook does order=created_at.desc&limit=1
      contact_id: c.id, created_at: c.created_at, status: c.status,
      campaign_id: c.campaign_id, campaign_name: camp?.name || null,
      auto_reply_enabled: camp?.auto_reply_enabled ?? null,
      auto_reply_message_preview: camp?.auto_reply_message ? camp.auto_reply_message.slice(0, 60) : null,
      auto_replied: c.auto_replied,
      blockedBecause: reasons,
    };
  });

  // Also pull the RAW inbound + outbound history for this exact phone string,
  // all-time (no date cutoff) — this tells us whether the webhook ever even
  // logged a "yes" for this number more than once, and whether an auto-reply
  // attempt (sent OR failed) was ever recorded in kmc_outbound, in case it
  // exists but isn't showing up in the Inbox thread for some other reason.
  const [inboundRows, outboundRows] = await Promise.all([
    sb.getAll('kmc_replies',  `from=eq.${encodeURIComponent(phone)}&order=timestamp.desc`),
    sb.getAll('kmc_outbound', `to=eq.${encodeURIComponent(phone)}&order=sent_at.desc`),
  ]);

  res.json({
    phone,
    totalContactRecords: records.length,
    records,
    inboundHistory: inboundRows.map(r => ({ id: r.id, type: r.type, text: r.text?.slice(0, 60), timestamp: r.timestamp })),
    outboundHistory: outboundRows.map(r => ({ id: r.id, campaign_id: r.campaign_id, status: r.status, text: r.text?.slice(0, 60), sent_at: r.sent_at, telnyx_id: r.telnyx_id })),
  });
});

// Unstick contacts stuck in AWAITING_CALLBACK_TIME after form_link was missing.
// raw_time_text column may not exist in Supabase, so we recover the callback
// time text directly from kmc_replies: first inbound reply after the contact's
// YES reply = their callback time. Re-runs advanceFlow() so Message B + form
// link fires now that the campaign form_link is configured.
// Skips contacts flagged 'unparseable_time_reply' (still need human review).
// Defaults to dry-run (?dry=false to actually send).
app.post('/api/admin/unstick-callback', auth, async (req, res) => {
  const dryRun = req.query.dry !== 'false';

  const stuck = await sb.getAll('kmc_contacts',
    'flow_state=eq.AWAITING_CALLBACK_TIME&order=created_at.desc'
  );

  // Skip contacts whose time was genuinely unparseable — those still need a human.
  const candidates = stuck.filter(c => c.needs_human_reason !== 'unparseable_time_reply');

  // For each candidate, recover their callback-time reply from kmc_replies:
  // it's the first inbound message that arrived AFTER their YES reply.
  const eligible = [];
  for (const contact of candidates) {
    const allReplies = await sb.get('kmc_replies',
      `from=eq.${encodeURIComponent(contact.phone)}&order=timestamp.asc`
    );
    const yesIdx = allReplies.findIndex(r => r.type === 'yes');
    const callbackReply = yesIdx >= 0 ? allReplies[yesIdx + 1] : allReplies[0];
    if (!callbackReply?.text) continue;
    eligible.push({ contact, callbackText: callbackReply.text, replyTo: callbackReply.to });
  }

  if (dryRun) {
    return res.json({
      dryRun: true,
      total_stuck: stuck.length,
      skipped_unparseable: stuck.length - candidates.length,
      eligible: eligible.length,
      contacts: eligible.map(({ contact, callbackText }) => ({
        phone: contact.phone, name: contact.first_name,
        callback_text: callbackText, campaign_id: contact.campaign_id,
      })),
    });
  }

  let sent = 0, failed = 0;
  for (const { contact, callbackText, replyTo } of eligible) {
    // Clear stale needs_human flag before re-running flow
    await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: false, needs_human_reason: null });
    await advanceFlow(contact.phone, replyTo, 'yes', callbackText);
    const check = await sb.get('kmc_contacts', `id=eq.${contact.id}`);
    if (check[0]?.flow_state === 'CALL_SCHEDULED') { sent++; }
    else { failed++; console.log(`[Unstick] did not advance for ${contact.phone}`); }
  }

  console.log(`[Unstick] done — sent:${sent} failed:${failed}`);
  res.json({ dryRun: false, eligible: eligible.length, sent, failed });
});

// Re-blast: reset contacts who NEVER replied back to pending so they get
// blasted again with the new numbers. Includes both previously-sent AND
// previously-failed contacts (new numbers may succeed where old ones failed).
// Skips: anyone with ANY entry in kmc_replies (replied with anything),
//        anyone in the callback flow (AWAITING_CALLBACK_TIME / CALL_SCHEDULED),
//        opted-out numbers.
// Also clears assigned_from so new numbers are assigned on next blast.
// Defaults to dry-run (?dry=false to commit). Optional ?campaign_id=N to scope.
app.post('/api/admin/reblast-setup', auth, async (req, res) => {
  const dryRun     = req.query.dry !== 'false';
  const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id) : null;

  // Build set of phones that have replied with ANYTHING (yes/no/other)
  const allReplies = await sb.getAll('kmc_replies', 'select=from');
  const repliedPhones = new Set(allReplies.map(r => r.from).filter(Boolean));

  const optOuts = new Set((await sb.getAll('kmc_opt_outs', 'select=phone')).map(r => r.phone));

  // Pull all contacts for the campaign (all statuses — includes failed ones)
  let contactsQs = 'select=id,phone,campaign_id,flow_state,status';
  if (campaignId) contactsQs += `&campaign_id=eq.${campaignId}`;
  else contactsQs += '&campaign_id=not.is.null';
  const allContacts = await sb.getAll('kmc_contacts', contactsQs);

  const IN_FLOW = new Set(['AWAITING_CALLBACK_TIME', 'CALL_SCHEDULED', 'AWAITING_EMAIL', 'EMAIL_CAPTURED', 'OPTED_OUT']);

  const eligible     = allContacts.filter(c =>
    !optOuts.has(c.phone) &&
    !repliedPhones.has(c.phone) &&
    !IN_FLOW.has(c.flow_state) &&
    c.status !== 'opted_out'
  );
  const skippedReplied  = allContacts.filter(c => repliedPhones.has(c.phone));
  const skippedFlow     = allContacts.filter(c => IN_FLOW.has(c.flow_state));
  const skippedOptOut   = allContacts.filter(c => optOuts.has(c.phone) || c.status === 'opted_out');

  if (dryRun) {
    return res.json({
      dryRun: true,
      total_contacts:      allContacts.length,
      eligible_to_reblast: eligible.length,
      skipped_replied:     skippedReplied.length,
      skipped_in_flow:     skippedFlow.length,
      skipped_opted_out:   skippedOptOut.length,
    });
  }

  // Reset eligible contacts to pending + clear assigned_from (old numbers gone)
  for (let i = 0; i < eligible.length; i += 100) {
    const chunk = eligible.slice(i, i + 100);
    const ids   = chunk.map(c => c.id).join(',');
    await sb.patch('kmc_contacts', `id=in.(${ids})`, {
      status: 'pending', assigned_from: null, flow_state: 'AWAITING_INTEREST',
    });
  }

  // Reset affected campaigns: clear sent_today + set status back to 'paused'
  const campIds = [...new Set(eligible.map(c => c.campaign_id).filter(Boolean))];
  for (const id of campIds) {
    await sb.patch('kmc_campaigns', `id=eq.${id}`, {
      status: 'paused', sent_today: 0, last_sent_date: null, updated_at: new Date().toISOString(),
    });
  }

  console.log(`[ReblastSetup] reset ${eligible.length} contacts across ${campIds.length} campaigns`);
  res.json({
    dryRun: false,
    reset_contacts:    eligible.length,
    skipped_replied:   skippedReplied.length,
    skipped_in_flow:   skippedFlow.length,
    skipped_opted_out: skippedOptOut.length,
    campaigns_reset:   campIds,
  });
});

// Reclassify an inbound message type (yes / no / other)
app.patch('/api/messages/:id/type', auth, async (req, res) => {
  const { type } = req.body;
  if (!['yes','no','other'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  await sb.patch('kmc_replies', `id=eq.${req.params.id}`, { type });
  res.json({ ok: true });
});

// Bulk re-classify all existing "other" replies using the current classifyReply()
// logic. Defaults to dry-run (safe preview) — pass ?dry=false to commit.
// Optional ?since=2026-07-01 to limit scope to a date range.
// After a live run, the reconcile loop (runs every 10 min) will automatically
// detect any newly-classified 'yes' contacts still stuck in AWAITING_INTEREST
// and send them Message A — no extra action needed.
app.post('/api/admin/reclassify-others', auth, async (req, res) => {
  const dryRun = req.query.dry !== 'false';
  const since  = req.query.since || null;

  let qs = 'type=eq.other&order=timestamp.desc';
  if (since) qs += `&timestamp=gte.${since}`;

  const allOthers = await sb.getAll('kmc_replies', qs);

  const toYes = [], toNo = [];
  for (const reply of allOthers) {
    const newType = classifyReply(reply.text);
    if (newType === 'yes') toYes.push(reply);
    else if (newType === 'no')  toNo.push(reply);
  }

  if (!dryRun) {
    for (const r of toYes) await sb.patch('kmc_replies', `id=eq.${r.id}`, { type: 'yes' });
    for (const r of toNo)  await sb.patch('kmc_replies', `id=eq.${r.id}`, { type: 'no'  });
    console.log(`[Reclassify] committed: ${toYes.length} → yes, ${toNo.length} → no (of ${allOthers.length} others)`);
  } else {
    console.log(`[Reclassify] dry-run: would move ${toYes.length} → yes, ${toNo.length} → no (of ${allOthers.length} others)`);
  }

  res.json({
    dryRun,
    total_others:        allOthers.length,
    reclassified_to_yes: toYes.length,
    reclassified_to_no:  toNo.length,
    unchanged:           allOthers.length - toYes.length - toNo.length,
    ...(dryRun ? {
      preview_yes: toYes.slice(0, 30).map(r => ({ id: r.id, from: r.from, text: r.text?.slice(0, 80) })),
      preview_no:  toNo.slice(0,  30).map(r => ({ id: r.id, from: r.from, text: r.text?.slice(0, 80) })),
    } : {}),
  });
});

// Opt-outs
app.get('/api/opt-outs', auth, async (req, res) => {
  res.json(await sb.getAll('kmc_opt_outs', 'order=created_at.desc'));
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

// ── Callback-scheduling flow: time parsing ─────────────────────────────────────
// When chrono resolves an hour but couldn't tell AM from PM (e.g. "tomorrow at
// 3", "at 7" from a bare-number rewrite), chrono's own default is inconsistent
// (sometimes AM, sometimes it guesses right from context words like "tonight").
// Per spec: prefer whichever of the AM/PM readings falls in the plausible
// call window (8 AM–9 PM); if both or neither qualify, prefer PM (evening
// callback is the safer default for this business).
function resolveAmbiguousMeridiem(date, tz) {
  const hour24 = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(date));
  const hour12 = hour24 % 12;
  const amVariant = hour12;
  const pmVariant = hour12 + 12;
  const inWindow = h => h >= 8 && h < 21;
  let chosen;
  if (inWindow(pmVariant) && !inWindow(amVariant)) chosen = pmVariant;
  else if (inWindow(amVariant) && !inWindow(pmVariant)) chosen = amVariant;
  else chosen = pmVariant; // both or neither qualify — default to PM
  return new Date(date.getTime() + (chosen - hour24) * 3600000);
}

// Returns { kind: 'now'|'specific'|'vague'|'none', date: Date|null }
// - 'now'      → "now"/"asap"/"call me now" → Message B (now variant), call ASAP
// - 'specific' → an exact clock time was given → Message B, echo TIME_SHORT
// - 'vague'    → a broad window ("whenever", "tomorrow afternoon", "Tuesday",
//                "after 5") → Message B (vague variant, "Talk then!")
// - 'none'     → no parseable time (a question, an objection, anything else)
//                → caller must NOT auto-reply; flag needs_human instead
function parseCallbackTime(text, tz) {
  const raw = (text || '').trim();
  if (!raw) return { kind: 'none', date: null };
  // A question mixed in with a time ("7pm but who is this?") must NOT be
  // auto-confirmed — a human should handle it, per spec's explicit edge case.
  if (/\?/.test(raw)) return { kind: 'none', date: null };
  if (/\b(now|asap|right now|call me now)\b/i.test(raw)) return { kind: 'now', date: new Date() };
  if (/\b(anytime|whenever)\b/i.test(raw)) return { kind: 'vague', date: null };

  const ref  = new Date();
  const opts = { forwardDate: true, timezone: tz };

  // "after 5" / "after 5pm" describes an open-ended window, not a fixed
  // moment — always vague, regardless of whether chrono can resolve an hour.
  // No forwardDate here (see note below on the bare-hour branch) — with no
  // other date anchor, chrono's own forward-rolling would push a still-
  // upcoming-today PM reading to tomorrow before we get to pick it.
  if (/\bafter\s+\d{1,2}\b/i.test(raw)) {
    const r = chrono.parse(raw.replace(/\bafter\s+(\d{1,2})/i, 'from $1'), ref, { timezone: tz });
    if (!r.length) return { kind: 'vague', date: null };
    let d = r[0].start.date();
    if (!r[0].start.isCertain('meridiem')) {
      d = resolveAmbiguousMeridiem(d, tz);
      if (d.getTime() <= ref.getTime()) d = new Date(d.getTime() + 86400000);
    }
    return { kind: 'vague', date: d };
  }

  let results = chrono.parse(raw, ref, opts);
  // Bare hour numbers ("7", or the first number in "7 or 8") aren't parsed by
  // chrono on their own — prefixing "at " gets it to treat it as a time.
  // Deliberately no forwardDate for this fallback: with no other date anchor
  // (weekday, "tomorrow", etc.), chrono defaults the ambiguous meridiem to AM
  // and — with forwardDate — rolls the whole calendar day forward whenever
  // that AM guess has already passed, even if the PM reading (chosen below)
  // is still hours away today. E.g. bare "7" received at 2 PM must mean 7 PM
  // *today* per spec, not 7 PM tomorrow. We resolve the meridiem ourselves
  // first, then only roll forward a day if the chosen reading has itself
  // already passed relative to ref.
  if (!results.length && /\b([1-9]|1[0-2])\b/.test(raw)) {
    results = chrono.parse('at ' + raw, ref, { timezone: tz });
  }
  if (!results.length) return { kind: 'none', date: null };

  const c = results[0];
  let date = c.start.date();
  if (!c.start.isCertain('meridiem')) {
    date = resolveAmbiguousMeridiem(date, tz);
    if (date.getTime() <= ref.getTime()) date = new Date(date.getTime() + 86400000);
  }
  const kind = c.start.isCertain('hour') ? 'specific' : 'vague';
  return { kind, date };
}

// Lightly normalizes the lead's own phrasing for the {TIME_ECHO} placeholder —
// per spec, we echo their wording back, not a converted timestamp string
// ("tomorrow at 3" stays "tomorrow at 3"). The one exception: a bare number
// ("7") is echoed with its resolved AM/PM so the confirmation isn't itself
// ambiguous to the lead.
function normalizeTimeEcho(raw, kind, date, tz) {
  const trimmed = raw.trim();
  if (/^\d{1,2}$/.test(trimmed) && date) return formatTimeShort(date, tz);
  let out = trimmed.replace(/(\d{1,2}(:\d{2})?)\s*([ap])\.?m\.?/gi, (m, h, min, ap) => `${h} ${ap.toUpperCase()}M`);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// {TIME_SHORT} — "7 PM" (today), "7 PM tomorrow", or "7 PM Tue" (further out)
function formatTimeShort(date, tz, ref = new Date()) {
  const hasMinutes = new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: tz }).format(date) !== '0';
  const hourLabel = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: hasMinutes ? '2-digit' : undefined, hour12: true, timeZone: tz }).format(date);
  const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); // yyyy-mm-dd, stable for comparison
  if (dayKey(date) === dayKey(ref)) return hourLabel;
  const tomorrow = new Date(ref.getTime() + 86400000);
  if (dayKey(date) === dayKey(tomorrow)) return `${hourLabel} tomorrow`;
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(date);
  return `${hourLabel} ${weekday}`;
}

// ── Callback-scheduling flow: per-conversation state machine ───────────────────
// Restructures the old "YES → instant form link" auto-reply into:
//   AWAITING_INTEREST → (YES) → Message A (ask for a callback time) → AWAITING_CALLBACK_TIME
//   AWAITING_CALLBACK_TIME → (parseable time) → Message B (+ form link, now with
//     context) → CALL_SCHEDULED
//   AWAITING_CALLBACK_TIME → (anything unparseable) → needs_human, no auto-reply
//   CALL_SCHEDULED → (any further inbound) → needs_human, no auto-reply (never
//     restarts the flow or re-sends the form link)
// Isolated in its own try/catch, same reasoning as the old maybeAutoReply: a
// failure here can never take down the inbound-logging step above it.
async function advanceFlow(from, to, type, text) {
  try {
    const contacts = await sb.get('kmc_contacts', `phone=eq.${encodeURIComponent(from)}&order=created_at.desc&limit=1`);
    let contact = contacts[0];

    // No contact row found — this happens when a contact's campaign was deleted
    // (which also deletes kmc_contacts rows) but they reply YES afterward.
    // Rather than silently dropping their YES, auto-create a minimal orphan row
    // so the flow can proceed: we know their phone, the KMC number they replied
    // to (= `to`), and that they said YES. Address is unknown so Message A will
    // say "your property" — good enough to keep the conversation alive.
    if (!contact && type === 'yes') {
      console.log(`[Flow] no contact row for ${from} — creating orphan row and sending Message A`);
      const newRow = {
        phone: from, first_name: '', address: '', campaign_id: null,
        assigned_from: ALL_SET.has(to) ? to : null,
        status: 'sent', flow_state: 'AWAITING_INTEREST',
        lead_timezone: 'America/New_York',
        created_at: new Date().toISOString(),
      };
      const created = await sb.post('kmc_contacts', newRow);
      if (!created.ok) { console.log(`[Flow] skip ${from} — no contact row and failed to create orphan`); return; }
      // Re-fetch the just-created row so we have its id
      const refetch = await sb.get('kmc_contacts', `phone=eq.${encodeURIComponent(from)}&order=created_at.desc&limit=1`);
      contact = refetch[0];
      if (!contact) { console.log(`[Flow] skip ${from} — orphan row created but refetch failed`); return; }
    }

    if (!contact) { console.log(`[Flow] skip ${from} — no kmc_contacts row found`); return; }
    if (contact.flow_state === 'OPTED_OUT' || contact.status === 'opted_out') {
      console.log(`[Flow] skip ${from} — opted out`); return;
    }

    // Automated reply from the recipient (business autoresponder / bot). Never
    // treat it as a real answer — that's what created the send→their-bot→send
    // loop. Skip advancing the flow entirely, UNLESS the message actually
    // contains an email (never drop a genuine email capture). One-time flag so
    // a human can eyeball these obvious bot numbers.
    if (isAutoresponder(text) && !EMAIL_RE.test(text)) {
      if (!contact.needs_human) {
        await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: true, needs_human_reason: 'autoresponder_detected' });
      }
      console.log(`[Flow] ${from} — autoresponder detected, not advancing: "${(text||'').slice(0,50)}"`);
      return;
    }

    // ── AUTO-REPLIES ARE OPT-IN PER CAMPAIGN ────────────────────────────────
    // Nothing is ever sent automatically unless the campaign has
    // auto_reply_enabled = true. Otherwise every reply just lands in the Inbox
    // for manual handling. Orphan contacts (no campaign) never auto-reply.
    if (!contact.campaign_id) {
      console.log(`[Flow] ${from} — no campaign on contact, no auto-reply (manual only)`); return;
    }
    const flowCampRows = await sb.get('kmc_campaigns', `id=eq.${contact.campaign_id}`);
    const flowCamp = flowCampRows[0] || null;
    if (!flowCamp || !flowCamp.auto_reply_enabled) {
      console.log(`[Flow] ${from} — auto-replies disabled for campaign ${contact.campaign_id}, leaving for manual handling`); return;
    }

    const tz = contact.lead_timezone || 'America/New_York';

    // ── AWAITING_INTEREST: what advances the flow depends on flow_type.
    //   'callback' (default)  → only a YES → Message A (ask for a callback time)
    //   'email_capture'       → any ENGAGED reply (not a hard 'no') → detect
    //                           their buyer type, tag them, then ask for email.
    // A 'no' never advances either flow; STOP is fully handled upstream.
    if (contact.flow_state === 'AWAITING_INTEREST' || !contact.flow_state) {
      // 'no' is a decline for both flows — never advances.
      if (type === 'no') return;
      const camp = flowCamp; // already fetched + auto_reply_enabled-gated above

      const replyFrom = contact.assigned_from && ALL_SET.has(contact.assigned_from) ? contact.assigned_from : to;

      if (camp.flow_type === 'email_capture') {
        // Any engaged reply advances (a "wholesaler"/"cash buyer" answer to the
        // "which are you?" opener classifies as 'other', not 'yes'). Detect and
        // tag their buyer type from the reply, then ask for their email.
        const buyerType = detectBuyerType(text);
        // ATOMIC CLAIM before the human-delay + send. The old code slept 120s
        // while flow_state was still AWAITING_INTEREST, so a burst of inbound
        // (autoresponders fire several) each started its own delayed send →
        // duplicate email-asks. This conditional update only succeeds for the
        // FIRST handler; concurrent/later ones get 0 rows and bail. Guards the
        // reconcile loop too.
        const claim = await sb.patch('kmc_contacts',
          `id=eq.${contact.id}&or=(flow_state.is.null,flow_state.eq.AWAITING_INTEREST)`,
          { flow_state: 'AWAITING_EMAIL', auto_replied: true, ...(buyerType ? { buyer_type: buyerType } : {}) });
        if (!Array.isArray(claim.data) || claim.data.length === 0) {
          console.log(`[Flow] ${from} — email-ask already claimed (or claim failed), skipping duplicate`);
          return;
        }
        const asks = emailAskVariants(camp);
        const ask = asks[(contact.id || 0) % asks.length];
        if (MSG_A_DELAY_MS > 0) await sleep(MSG_A_DELAY_MS);
        const r = await sendSMS(replyFrom, from, ask);
        await sb.post('kmc_outbound', { campaign_id: camp.id, from: replyFrom, to: from, text: ask, status: r.ok ? 'sent' : 'failed', telnyx_id: r.id || null, sent_at: new Date().toISOString() });
        console.log(`[Flow] ${r.ok ? 'sent' : 'FAILED'} email-ask${buyerType ? ' ['+buyerType+']' : ''} — ${camp.name} → ${from}${r.errDetail ? ' — ' + r.errDetail : ''}`);
        return;
      }

      // Callback flow: only a YES advances.
      if (type !== 'yes') return;

      // ATOMIC CLAIM (same rationale as email_capture above) before the delayed
      // Message A send, so a burst of inbound / the reconcile loop can't each
      // fire their own Message A.
      const claimCb = await sb.patch('kmc_contacts',
        `id=eq.${contact.id}&or=(flow_state.is.null,flow_state.eq.AWAITING_INTEREST)`,
        { flow_state: 'AWAITING_CALLBACK_TIME', auto_replied: true });
      if (!Array.isArray(claimCb.data) || claimCb.data.length === 0) {
        console.log(`[Flow] ${from} — Message A already claimed (or claim failed), skipping duplicate`);
        return;
      }
      const msgA = MSG_A_TEMPLATE.replace(/\{PROPERTY_ADDRESS\}/g, contact.address || 'your property');
      // Wait before replying so it feels human, not like an instant bot. Safe
      // on Render: this fresh webhook request resets the 15-min idle-sleep timer,
      // so a 2-min wait won't get cut short by the instance spinning down.
      if (MSG_A_DELAY_MS > 0) await sleep(MSG_A_DELAY_MS);
      const r = await sendSMS(replyFrom, from, msgA);
      await sb.post('kmc_outbound', { campaign_id: camp.id, from: replyFrom, to: from, text: msgA, status: r.ok ? 'sent' : 'failed', telnyx_id: r.id || null, sent_at: new Date().toISOString() });
      console.log(`[Flow] ${r.ok ? 'sent' : 'FAILED'} Message A — ${camp.name} → ${from}${r.errDetail ? ' — ' + r.errDetail : ''}`);
      return;
    }

    // ── AWAITING_EMAIL (email_capture flow): every inbound here is scanned
    // for an email address — the YES/NO classification doesn't apply, except
    // that a clean 'no' is left alone (upstream already logged the decline).
    if (contact.flow_state === 'AWAITING_EMAIL') {
      const email = (text.match(EMAIL_RE) || [null])[0];
      if (!email) {
        if (type === 'no') { console.log(`[Flow] ${from} — declined while AWAITING_EMAIL, no action`); return; }
        await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: true, needs_human_reason: 'no_email_in_reply' });
        console.log(`[Flow] ${from} — reply without an email while AWAITING_EMAIL, flagged needs_human`);
        return;
      }

      let camp = null;
      if (contact.campaign_id) {
        const camps = await sb.get('kmc_campaigns', `id=eq.${contact.campaign_id}`);
        camp = camps[0] || null;
      }
      const cfg = camp?.flow_config || {};
      const replyFrom = contact.assigned_from && ALL_SET.has(contact.assigned_from) ? contact.assigned_from : to;

      // Store the email first — even if the pitch-email webhook fails, the
      // captured address must never be lost. Also back-fill buyer_type if we
      // couldn't detect it at intake but this reply reveals it.
      const lateType = !contact.buyer_type ? detectBuyerType(text) : null;
      await sb.patch('kmc_contacts', `id=eq.${contact.id}`, {
        email: email.toLowerCase(), email_captured_at: new Date().toISOString(), flow_state: 'EMAIL_CAPTURED',
        ...(lateType ? { buyer_type: lateType } : {}),
      });

      const wr = await postPitchEmail(cfg.email_webhook || EMAIL_PITCH_WEBHOOK_DEFAULT, {
        phone: from, email: email.toLowerCase(), name: contact.first_name || '',
      });
      if (!wr.ok) {
        // Don't text "just sent it over" when nothing was sent — flag for a human.
        await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: true, needs_human_reason: 'pitch_email_failed' });
        console.log(`[Flow] ${from} — email captured (${email}) but pitch-email webhook FAILED, flagged needs_human`);
        return;
      }

      const doneMsg = cfg.email_done || EMAIL_DONE_DEFAULT;
      const r = await sendSMS(replyFrom, from, doneMsg);
      await sb.post('kmc_outbound', { campaign_id: contact.campaign_id, from: replyFrom, to: from, text: doneMsg, status: r.ok ? 'sent' : 'failed', telnyx_id: r.id || null, sent_at: new Date().toISOString() });
      console.log(`[Flow] email captured ${email} → pitch email sent → ${r.ok ? 'sent' : 'FAILED'} confirmation SMS → ${from}`);
      return;
    }

    // ── EMAIL_CAPTURED: never auto-reply again — surface anything further to
    // a human, same policy as CALL_SCHEDULED.
    if (contact.flow_state === 'EMAIL_CAPTURED') {
      await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: true, needs_human_reason: 'message_after_email_captured' });
      console.log(`[Flow] ${from} — inbound while EMAIL_CAPTURED, flagged needs_human`);
      return;
    }

    // ── AWAITING_CALLBACK_TIME: every inbound message here is evaluated only
    // for whether it contains a usable callback time — the YES/NO/STOP
    // classification computed upstream doesn't apply to this state at all
    // (e.g. "sure" matches YES_RE but isn't a time; per spec this state cares
    // exclusively about time parsing).
    if (contact.flow_state === 'AWAITING_CALLBACK_TIME') {
      const parsed = parseCallbackTime(text, tz);

      if (parsed.kind === 'none') {
        await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: true, needs_human_reason: 'unparseable_time_reply', raw_time_text: text });
        console.log(`[Flow] ${from} — unparseable time reply, flagged needs_human`);
        return;
      }

      // Every path past this point sends a message containing the form
      // link, so resolve it once up front. Per approved item #4: if the
      // campaign has no form_link set, do NOT send Message B — flag
      // needs_human instead rather than sending a broken/blank link.
      let formLink = null;
      if (contact.campaign_id) {
        const camps = await sb.get('kmc_campaigns', `id=eq.${contact.campaign_id}`);
        formLink = camps[0]?.form_link || null;
      }
      if (!formLink) {
        await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: true, needs_human_reason: 'missing_form_link', raw_time_text: text });
        console.log(`[Flow] ${from} — parsed a callback time but campaign has no form_link, flagged needs_human`);
        return;
      }

      const replyFrom = contact.assigned_from && ALL_SET.has(contact.assigned_from) ? contact.assigned_from : to;

      // 'now' is treated as vague ("Now works, talk then!") — no separate
      // now-variant since the MSG_B_NOW_TEMPLATE has been removed per spec.
      if (parsed.kind === 'now') parsed.kind = 'vague';

      // 'specific' or 'vague' — both send Message B with the form link, just
      // with different closing lines.
      const timeEcho  = normalizeTimeEcho(text, parsed.kind, parsed.date, tz);
      const timeShort = parsed.date ? formatTimeShort(parsed.date, tz) : '';
      let msg = MSG_B_TEMPLATE.replace(/\{TIME_ECHO\}/g, timeEcho).replace(/\{FORM_LINK\}/g, formLink);
      msg = parsed.kind === 'vague'
        ? msg.replace(/Talk at \{TIME_SHORT\}!$/, MSG_B_VAGUE_SUFFIX)
        : msg.replace(/\{TIME_SHORT\}/g, timeShort);

      const r = await sendSMS(replyFrom, from, msg);
      await Promise.all([
        sb.post('kmc_outbound', { campaign_id: contact.campaign_id, from: replyFrom, to: from, text: msg, status: r.ok ? 'sent' : 'failed', telnyx_id: r.id || null, sent_at: new Date().toISOString() }),
        sb.patch('kmc_contacts', `id=eq.${contact.id}`, {
          flow_state: 'CALL_SCHEDULED',
          scheduled_call_time_utc: parsed.date ? parsed.date.toISOString() : null,
          raw_time_text: text, form_link_sent_at: new Date().toISOString(),
        }),
      ]);
      console.log(`[Flow] ${r.ok ? 'sent' : 'FAILED'} Message B (${parsed.kind}) → ${from}${r.errDetail ? ' — ' + r.errDetail : ''}`);
      return;
    }

    // ── CALL_SCHEDULED: never auto-reply again. A repeat YES is flagged
    // duplicate_yes; anything else while already scheduled still gets
    // surfaced to a human rather than silently ignored or auto-answered.
    if (contact.flow_state === 'CALL_SCHEDULED') {
      const reason = type === 'yes' ? 'duplicate_yes' : 'message_while_call_scheduled';
      await sb.patch('kmc_contacts', `id=eq.${contact.id}`, { needs_human: true, needs_human_reason: reason });
      console.log(`[Flow] ${from} — inbound while CALL_SCHEDULED, flagged needs_human (${reason})`);
      return;
    }
  } catch (e) {
    console.error(`[Flow] threw for ${from}:`, e.message);
  }
}

app.post('/webhook/sms', async (req, res) => {
  if (req.query.token !== WH_TOKEN) return res.status(401).end();
  res.sendStatus(200);
  let from, to, type = 'other', text = '';
  try {
    const ev = req.body;
    if (ev.data?.event_type !== 'message.received') return;
    const msg  = ev.data.payload;
    from = msg.from?.phone_number;
    to   = msg.to?.[0]?.phone_number;
    text = (msg.text || '').trim();
    // Accept inbound on ANY account number (all 26 share this webhook via the
    // messaging profile) — replies to non-KMC numbers used to be silently
    // dropped here, which killed the LeadMamba/investor reply loop.
    if (!from || !to || !ALL_SET.has(to)) return;

    if (STOP_RE.test(text)) {
      type = 'no';
      await Promise.all([
        sb.post('kmc_opt_outs', { phone: from, reason: 'STOP message', created_at: new Date().toISOString() }),
        sb.patch('kmc_contacts', `phone=eq.${encodeURIComponent(from)}`, { status: 'opted_out', flow_state: 'OPTED_OUT' }),
      ]);
    } else {
      type = classifyReply(text);
      // Non-STOP objection / not-interested reply — log to kmc_declines so their
      // number is permanently skipped on any future CSV upload, same as opt-outs.
      // Uses ignore-duplicates so re-texting someone before they reply a second
      // time won't throw; the UNIQUE constraint on phone handles dedup silently.
      if (type === 'no') {
        sb.post('kmc_declines', { phone: from, reason: text.slice(0, 200), created_at: new Date().toISOString() })
          .catch(e => console.error('[Declines] insert failed:', e.message));
      }
    }

    await sb.post('kmc_replies', { from, to, text, type, timestamp: new Date().toISOString(), synced: false });
    console.log(`[Inbound] ${type.toUpperCase()} | ${from} → ${to} | "${text.slice(0, 60)}"`);
  } catch(e) {
    console.error('[webhook] failed to log inbound reply:', e.message);
    // Fall through anyway — if we at least parsed `from`/`type` before the
    // error, still give the contact a shot at advancing the flow rather than
    // losing it entirely because logging hiccuped.
  }

  // Runs regardless of whether the block above succeeded, as long as we
  // parsed a phone number. STOP is already fully handled above (opt-out is
  // immediate at every state); everything else routes through the state
  // machine, which itself re-checks opted_out/flow_state before doing
  // anything, so this is safe even for a STOP message.
  if (from && to) await advanceFlow(from, to, type, text);
});

// Auto-blast active campaigns every 10 minutes
setInterval(async () => {
  try {
    const active = await sb.get('kmc_campaigns', 'status=eq.active&order=updated_at.asc');
    for (const c of active) await runBlast(c);
  } catch(e) { console.error('[auto-blast]', e.message); }
}, 10 * 60 * 1000);

// Self-healing safety net: re-scan recent "yes" replies and re-run the exact
// same advanceFlow() eligibility check the webhook uses. This is a pure
// backstop — it does NOT assume we know why a step might be missed (webhook
// downtime, a thrown error, Render restarting mid-request, a future bug
// nobody has thought of yet). It just periodically asks "is there anyone who
// said yes and is still stuck in AWAITING_INTEREST?" and if so, re-sends
// Message A.
//
// State-aware by design: a contact is only re-processed if they're STILL in
// flow_state='AWAITING_INTEREST' despite having a "yes" on file. Anyone who
// has already progressed (AWAITING_CALLBACK_TIME, CALL_SCHEDULED,
// OPTED_OUT) is left completely alone — re-running advanceFlow on someone
// already past AWAITING_INTEREST would misinterpret their old "yes" message
// as a fresh reply to whatever state they're currently in (e.g. it would try
// to parse "yes" as a callback time for someone in AWAITING_CALLBACK_TIME,
// or flag a phantom duplicate_yes for someone already CALL_SCHEDULED). This
// is exactly the same one-time-only guarantee the old auto_replied flag gave
// us, just expressed through flow_state instead.
async function reconcileMissedAutoReplies() {
  try {
    // Only look back 7 days — anything older is assumed either handled or
    // stale enough that the user would rather review it manually than get a
    // surprise message days later.
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const yesReplies = await sb.getAll('kmc_replies', `type=eq.yes&timestamp=gte.${since}&order=timestamp.desc`);

    const seen = new Set();
    let checked = 0, advanced = 0;
    for (const reply of yesReplies) {
      if (seen.has(reply.from)) continue;
      seen.add(reply.from);
      checked++;

      const contacts = await sb.get('kmc_contacts', `phone=eq.${encodeURIComponent(reply.from)}&order=created_at.desc&limit=1`);
      const contact = contacts[0];
      if (!contact || contact.flow_state !== 'AWAITING_INTEREST') continue; // already progressed — leave alone

      advanced++;
      await advanceFlow(reply.from, reply.to, 'yes', reply.text);
    }
    if (checked) console.log(`[Reconcile] checked ${checked} unique "yes" repliers from the last 7 days — re-sent Message A to ${advanced} still stuck in AWAITING_INTEREST`);

    // Email-capture campaigns: an investor answering "wholesaler"/"cash buyer"
    // to the "which are you?" opener classifies as 'other', so the yes-only
    // pass above can't rescue a missed one. Scan recent ENGAGED (non-'no')
    // replies that landed on an email-capture campaign's numbers and re-run the
    // flow for anyone still stuck in AWAITING_INTEREST. Scoped to those
    // campaigns' numbers so it never scans the (huge) seller-campaign traffic.
    const emailCamps = await sb.get('kmc_campaigns', 'flow_type=eq.email_capture&select=id,numbers');
    if (emailCamps.length) {
      const nums = new Set();
      emailCamps.forEach(c => campaignNumbers(c).forEach(n => nums.add(n)));
      const enc = [...nums].map(encodeURIComponent).join(',');
      const engaged = await sb.getAll('kmc_replies', `type=neq.no&to=in.(${enc})&timestamp=gte.${since}&order=timestamp.desc`);
      const seenEc = new Set();
      let ecChecked = 0, ecAdvanced = 0;
      for (const reply of engaged) {
        if (seenEc.has(reply.from)) continue;
        seenEc.add(reply.from);
        ecChecked++;
        const contacts = await sb.get('kmc_contacts', `phone=eq.${encodeURIComponent(reply.from)}&order=created_at.desc&limit=1`);
        const contact = contacts[0];
        if (!contact || contact.flow_state !== 'AWAITING_INTEREST') continue; // already progressed
        ecAdvanced++;
        await advanceFlow(reply.from, reply.to, reply.type, reply.text);
      }
      if (ecChecked) console.log(`[Reconcile] email-capture: checked ${ecChecked} engaged repliers — advanced ${ecAdvanced} still stuck in AWAITING_INTEREST`);
    }

    if (NUDGE_ENABLED) await sendOverdueNudges();
  } catch (e) {
    console.error('[Reconcile] failed:', e.message);
  }
}

// Optional Step 5.6 nudge (default OFF — see NUDGE_ENABLED at the top of the
// file). Finds contacts stuck in AWAITING_CALLBACK_TIME for longer than
// NUDGE_DELAY_MS and sends exactly one reminder. "Already nudged" is
// determined by checking kmc_outbound history for a prior send of the exact
// nudge text to that phone, rather than a dedicated DB column — this keeps
// the feature fully self-contained (no extra migration needed) while it's
// off by default; "when they entered AWAITING_CALLBACK_TIME" is likewise
// approximated from their most recent "yes" in kmc_replies, since that's the
// message that triggered the transition into this state and no dedicated
// state-entry timestamp column exists.
async function sendOverdueNudges() {
  const stuck = await sb.getAll('kmc_contacts', 'flow_state=eq.AWAITING_CALLBACK_TIME&order=created_at.desc');
  for (const contact of stuck) {
    const replies = await sb.get('kmc_replies', `from=eq.${encodeURIComponent(contact.phone)}&type=eq.yes&order=timestamp.desc&limit=1`);
    const enteredAt = replies[0]?.timestamp;
    if (!enteredAt || Date.now() - new Date(enteredAt).getTime() < NUDGE_DELAY_MS) continue;

    const already = await sb.get('kmc_outbound', `to=eq.${encodeURIComponent(contact.phone)}&text=eq.${encodeURIComponent(NUDGE_TEXT)}&limit=1`);
    if (already.length) continue;

    const replyFrom = contact.assigned_from && ALL_SET.has(contact.assigned_from) ? contact.assigned_from : KMC_NUMBERS[0];
    const r = await sendSMS(replyFrom, contact.phone, NUDGE_TEXT);
    await sb.post('kmc_outbound', { campaign_id: contact.campaign_id, from: replyFrom, to: contact.phone, text: NUDGE_TEXT, status: r.ok ? 'sent' : 'failed', telnyx_id: r.id || null, sent_at: new Date().toISOString() });
    console.log(`[Nudge] ${r.ok ? 'sent' : 'FAILED'} → ${contact.phone}`);
  }
}

// Run shortly after boot (in case something was missed while the server was
// down/restarting) and then every 10 minutes going forward, offset from the
// auto-blast loop so they don't hammer Supabase in the same tick.
setTimeout(reconcileMissedAutoReplies, 60 * 1000);
setInterval(reconcileMissedAutoReplies, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`KMC Blast Dashboard → http://localhost:${PORT}`));
