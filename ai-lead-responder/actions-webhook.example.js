/**
 * actions-webhook.example.js  —  Flagship: n8n ACTS on Kairvio
 * ============================================================
 * Sanitized excerpt of Kairvio's inbound ACTION endpoint.
 *
 * The earlier inbound receiver only let n8n *feed leads in*. This endpoint lets
 * n8n *act* on a conversation — reply to the customer and advance the lead. That
 * is what makes the integration bidirectional in a deep way: Kairvio emits
 * `lead.created`, n8n triages it with an AI node, then n8n calls back HERE to
 * send the drafted reply and move the lead to "contacted" — no human in the loop.
 *
 * Auth: token-based, identical to the lead receiver — Authorization: Bearer
 * <token>. The token resolves to exactly one business (tenant). The tenant is
 * NEVER read from the request body.
 *
 * Safety built in: every query is scoped to the token's business, outbound SMS
 * is rate-limited, and lead_status is validated against the known pipeline.
 *
 * POST JSON:
 *   { "action": "send_reply", "conversation_id": "<uuid>",
 *     "message": "Hi! Thanks for reaching out…", "lead_status": "contacted" }
 *
 * The SMS provider (Twilio in production) is abstracted to sendSms() below so
 * this reads provider-agnostic.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Forward-only lead pipeline — replies validated against these.
const VALID_LEAD_STATUS = ['new_lead', 'contacted', 'quote_sent', 'booked', 'paid', 'lost'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed. Use POST.' });

  const supabase = createClient(process.env.DB_URL, process.env.DB_SERVICE_KEY);

  // ── 1. Auth: resolve the token → exactly one business (the tenant) ────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return json(401, { error: 'Missing token. Use Authorization: Bearer.' });

  try {
    const { data: webhookConfig } = await supabase
      .from('webhook_configs')
      .select('business_id, enabled')
      .eq('webhook_token', token)
      .eq('enabled', true)
      .single();
    if (!webhookConfig) return json(401, { error: 'Invalid or disabled token.' });
    const businessId = webhookConfig.business_id;

    const body = JSON.parse(event.body || '{}');
    const action = (body.action || '').trim();
    const conversationId = (body.conversation_id || '').trim();
    if (!conversationId) return json(400, { error: 'conversation_id is required.' });

    // ── 2. Load the conversation, scoped to this tenant ─────────────────────
    // Scoping by business_id here is the tenant-isolation boundary: a token can
    // only ever touch its own business's conversations.
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, customer_number')
      .eq('id', conversationId)
      .eq('business_id', businessId)
      .single();
    if (!conversation) return json(404, { error: 'Conversation not found for this business.' });

    // ── 3a. Action: just move the lead in the pipeline ──────────────────────
    if (action === 'set_lead_status') {
      const status = (body.lead_status || '').trim();
      if (!VALID_LEAD_STATUS.includes(status)) {
        return json(400, { error: `lead_status must be one of: ${VALID_LEAD_STATUS.join(', ')}` });
      }
      await supabase.from('conversations')
        .update({ lead_status: status })
        .eq('id', conversationId).eq('business_id', businessId);
      return json(200, { success: true, conversation_id: conversationId, lead_status: status });
    }

    // ── 3b. Action: send the AI-drafted reply as an SMS + advance the lead ──
    if (action === 'send_reply') {
      const message = (body.message || '').trim();
      if (!message) return json(400, { error: 'message is required for send_reply.' });
      if (!conversation.customer_number) return json(400, { error: 'Conversation has no phone number.' });

      // Rate limit: cap outbound SMS per business per hour (abuse / runaway guard).
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recentCount } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('direction', 'outbound')
        .eq('channel', 'sms')
        .gte('created_at', oneHourAgo);
      if (recentCount && recentCount >= 100) {
        return json(429, { error: 'SMS rate limit exceeded.' });
      }

      // Send via the business's own SMS sender (provider abstracted).
      const sid = await sendSms(supabase, businessId, conversation.customer_number, message);

      // Record the outbound message on the conversation.
      await supabase.from('messages').insert({
        business_id: businessId,
        conversation_id: conversationId,
        customer_number: conversation.customer_number,
        body: message,
        direction: 'outbound',
        channel: 'sms',
        read: true,
      });

      // Advance the pipeline (default → contacted; only ever moves forward).
      const nextStatus = VALID_LEAD_STATUS.includes((body.lead_status || '').trim())
        ? body.lead_status.trim() : 'contacted';
      await supabase.from('conversations')
        .update({ last_message_at: new Date().toISOString(), last_message_preview: message.substring(0, 100) })
        .eq('id', conversationId).eq('business_id', businessId);
      await supabase.from('conversations')
        .update({ lead_status: nextStatus })
        .eq('id', conversationId).eq('business_id', businessId)
        .in('lead_status', ['new_lead', 'contacted']);

      return json(200, { success: true, conversation_id: conversationId, sid, lead_status: nextStatus });
    }

    return json(400, { error: `Unknown action: ${action}.` });
  } catch (err) {
    console.error('actions error:', err);
    return json(500, { error: 'Internal server error.' });
  }
};

/**
 * Send an SMS from the business's own number. In production this loads the
 * tenant's messaging config and calls the SMS provider (Twilio); stubbed here.
 */
async function sendSms(supabase, businessId, toNumber, body) {
  const { data: business } = await supabase
    .from('businesses')
    .select('sms_from_number, sms_service_id')
    .eq('id', businessId)
    .single();
  if (!business?.sms_from_number) throw new Error('No SMS number provisioned for this business.');

  // const provider = createSmsProvider(process.env.SMS_API_KEY, process.env.SMS_API_SECRET);
  // const sent = await provider.messages.create({ from: business.sms_from_number, to: toNumber, body });
  // return sent.sid;
  return 'STUBBED_MESSAGE_SID';
}

function json(statusCode, obj) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
