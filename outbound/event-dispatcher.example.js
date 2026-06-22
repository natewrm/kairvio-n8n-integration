/**
 * event-dispatcher.example.js  —  Direction 2: Kairvio → n8n (OUTBOUND)
 * ====================================================================
 * Sanitized excerpt of Kairvio's outbound event dispatcher.
 *
 * The design constraint I set for myself: add outbound automation WITHOUT
 * risking the running product. So the whole feature is ~40 lines, lives in its
 * own module, and is OFF BY DEFAULT:
 *
 *   - If N8N_WEBHOOK_URL is unset, dispatchToN8n() is a pure no-op. Production
 *     behaves exactly as it did before this file existed.
 *   - When set, it fire-and-forgets a POST to a single n8n "Webhook" trigger
 *     node. n8n then owns "what happens next" (Slack, Sheets, CRM, AI scoring),
 *     so Kairvio never hard-codes any downstream tool.
 *   - It NEVER throws and is bounded by a short timeout, so a slow or dead n8n
 *     can never hang or fail the Kairvio request that triggered it.
 *
 * Event names deliberately REUSE Kairvio's existing internal vocabulary
 * (the same strings already written to its activity/notification logs) rather
 * than inventing a parallel event taxonomy.
 *
 * Call sites (see ../inbound/lead-webhook.example.js for one in context):
 *   dispatchToN8n('lead.created',      { ... })  // new inbound lead
 *   dispatchToN8n('payment_received',  { ... })  // Stripe payment succeeded
 *   dispatchToN8n('quote_accepted',    { ... })  // customer accepted a quote
 *   dispatchToN8n('quote_declined',    { ... })  // customer declined a quote
 */

const DISPATCH_TIMEOUT_MS = 3000;

/**
 * Fire a Kairvio event to the configured n8n webhook.
 *
 * @param {string} eventType - dot/snake-namespaced event name, e.g. 'lead.created'
 * @param {object} data      - event payload (data Kairvio already owns)
 * @returns {Promise<{dispatched: boolean, status?: number, reason?: string, error?: string}>}
 */
async function dispatchToN8n(eventType, data) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) {
    // Off by default — additive, non-breaking. This is the production state
    // until someone explicitly opts in by setting the env var.
    return { dispatched: false, reason: 'N8N_WEBHOOK_URL not configured' };
  }

  const payload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    source: 'kairvio',
    data: data || {},
  };

  const headers = { 'Content-Type': 'application/json' };
  // Optional shared secret so the n8n workflow can verify the sender.
  if (process.env.N8N_WEBHOOK_SECRET) {
    headers['X-Kairvio-Signature'] = process.env.N8N_WEBHOOK_SECRET;
  }

  // Hard timeout: a downstream outage must not be able to hang the caller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[n8n] dispatch ${eventType} -> HTTP ${res.status}`);
      return { dispatched: false, status: res.status };
    }
    return { dispatched: true, status: res.status };
  } catch (err) {
    // Swallowed on purpose: outbound automation is best-effort and must never
    // surface as an error in the request that triggered it.
    console.error(`[n8n] dispatch ${eventType} failed:`, err.message);
    return { dispatched: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { dispatchToN8n };
