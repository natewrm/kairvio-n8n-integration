/**
 * lead-webhook.example.js  —  Direction 1: n8n → Kairvio (INBOUND)
 * =================================================================
 * Sanitized excerpt of Kairvio's universal inbound webhook receiver.
 *
 * The point of this file: when I built the n8n integration, this receiver
 * ALREADY existed and was already generic ("accepts leads from Zapier, Make,
 * custom integrations, or any HTTP client"). n8n's HTTP Request node is just
 * another HTTP client, so the inbound direction needed ZERO new app code —
 * only an n8n workflow pointed at this endpoint.
 *
 * Runtime in production: a serverless function (Netlify Functions, Node 18+).
 * Auth: a per-tenant token (Authorization: Bearer <token>) that maps an
 * incoming request to exactly one business — the tenant is NEVER taken from
 * the request body.
 *
 * Kairvio-internal helpers (Twilio SMS, plan checks, A2P number resolution)
 * are stubbed below with comments so this reads standalone. The control flow,
 * validation, and data model are the real thing.
 */

const { createClient } = require('@supabase/supabase-js'); // Postgres + RLS

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  // Service-role client: this is a public endpoint with no end-user JWT, so the
  // function authorizes the request itself via the webhook token (below).
  const supabase = createClient(process.env.DB_URL, process.env.DB_SERVICE_KEY);

  // ── 1. Extract the webhook token ──────────────────────────────────────────
  // Prefer the Authorization header; query-param fallback is legacy (tokens in
  // URLs leak via logs/referrers).
  let token = '';
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim();
  if (!token) token = (event.queryStringParameters || {}).token || '';
  if (!token) {
    return json(401, { error: 'Missing webhook token. Use Authorization: Bearer.' });
  }

  try {
    // ── 2. Resolve token → tenant ───────────────────────────────────────────
    // The token is the ONLY thing that identifies the business. This is the
    // tenant-isolation boundary for an unauthenticated public endpoint.
    const { data: webhookConfig } = await supabase
      .from('webhook_configs')
      .select('*, businesses(id, business_name)')
      .eq('webhook_token', token)
      .eq('enabled', true)
      .single();

    if (!webhookConfig) {
      return json(401, { error: 'Invalid or disabled webhook token.' });
    }

    const businessId = webhookConfig.business_id;
    const sourceName = webhookConfig.source_name || 'webhook';

    // (Kairvio also runs a soft plan-access check here — omitted for clarity.)

    // ── 3. Parse body (JSON or form-encoded) ────────────────────────────────
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      body = Object.fromEntries(new URLSearchParams(event.body).entries());
    }

    // ── 4. Validate + normalize phone (the one required field) ───────────────
    const rawPhone = (body.phone || '').trim();
    if (!rawPhone) return json(400, { error: 'Phone number is required.' });

    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 10) return json(400, { error: 'Invalid phone number.' });

    // Normalize to E.164 (this example assumes US/CA defaults).
    const e164 =
      digits.length === 10 ? '+1' + digits
      : digits.length === 11 && digits.startsWith('1') ? '+' + digits
      : rawPhone;

    const customerName = (body.name || '').trim();
    const customerEmail = (body.email || '').trim();
    const message = (body.message || '').trim();

    // Trust the configured source unless the caller passes a known override.
    const knownSources = ['webhook', 'web_form', 'facebook_ads', 'google_ads'];
    const leadSource = knownSources.includes((body.source || '').trim())
      ? body.source.trim()
      : sourceName;

    // ── 5. Find or create the customer (scoped to this tenant) ───────────────
    let customerId = null;
    const { data: existing } = await supabase
      .from('customers')
      .select('id')
      .eq('business_id', businessId)
      .or(`phone.eq.${e164},phone.eq.${digits}`)
      .limit(1)
      .maybeSingle();

    if (existing) {
      customerId = existing.id;
    } else {
      const parts = (customerName || 'Unknown').split(/\s+/);
      const { data: created } = await supabase
        .from('customers')
        .insert({
          business_id: businessId,
          phone: e164,
          first_name: parts[0] || null,
          last_name: parts.slice(1).join(' ') || null,
          email: customerEmail || null,
        })
        .select('id')
        .single();
      customerId = created?.id;
    }

    // ── 6. Compose a readable message body from the submitted fields ─────────
    const lines = [];
    if (customerName) lines.push('Name: ' + customerName);
    if (rawPhone) lines.push('Phone: ' + rawPhone);
    if (customerEmail) lines.push('Email: ' + customerEmail);
    if (message) lines.push('Message: ' + message);
    const messageBody = lines.join('\n') || 'New lead via webhook';

    // ── 7. Create/update the conversation, then insert the inbound message ───
    const { data: conv } = await supabase
      .from('conversations')
      .insert({
        business_id: businessId,
        customer_id: customerId,
        customer_number: e164,
        customer_name: customerName || null,
        channel: 'web_form',
        lead_source: leadSource,
        lead_status: 'new_lead',
        status: 'open',
        last_message_at: new Date().toISOString(),
        last_message_preview: messageBody.substring(0, 100),
        unread_count: 1,
      })
      .select('id')
      .single();

    if (conv?.id) {
      await supabase.from('messages').insert({
        business_id: businessId,
        conversation_id: conv.id,
        customer_number: e164,
        body: messageBody,
        direction: 'inbound',
        channel: 'web_form',
        read: false,
      });
    }

    // (Kairvio also SMS-notifies the business owner here via Twilio — omitted.)

    // ── 8. Close the loop: emit an OUTBOUND event so n8n can react ───────────
    // This is Direction 2 (see ../outbound/event-dispatcher.example.js). It is
    // a no-op unless N8N_WEBHOOK_URL is set, so it never affects this response.
    const { dispatchToN8n } = require('../outbound/event-dispatcher.example.js');
    await dispatchToN8n('lead.created', {
      business_id: businessId,
      conversation_id: conv?.id || null,
      customer_id: customerId || null,
      customer_name: customerName || null,
      customer_phone: e164,
      customer_email: customerEmail || null,
      message: message || null,
      lead_source: leadSource,
    });

    return json(200, { success: true, conversation_id: conv?.id || null });
  } catch (err) {
    console.error('lead-webhook error:', err);
    return json(500, { error: 'Internal server error.' });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
