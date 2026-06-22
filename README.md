# Kairvio ↔ n8n Bidirectional Integration

Two-way integration that turns n8n into Kairvio's automation layer — leads flow IN via webhook, lifecycle events flow OUT via a small env-var-gated dispatcher.

> _Shared publicly for demonstration and evaluation purposes only. This is a
> sanitized excerpt of integration code from Kairvio, a private product — not the
> product itself. © 2026 Kairvio — all rights reserved; not licensed for reuse._

> This repo is a **sanitized excerpt** of integration code I built into Kairvio, a
> production multi-tenant contact-center SaaS. It documents the integration
> *through code* — the control flow and data model are real; production URLs,
> secrets, and customer data have been removed. See [`docs/architecture.md`](docs/architecture.md).

## Why this exists

Kairvio unifies a local service business's customer communication (SMS, email,
social, voice) into one inbox, then layers scheduling, quoting, invoicing, and
payments on top — one funnel: **lead → job → paid**. Every business wants that
funnel wired into the rest of *its* stack: Slack, Google Sheets, a CRM, ad
platforms, an AI lead-scoring step. The design goal here was to enable all of
that **without Kairvio hard-coding a single one of those tools.** n8n becomes the
automation layer *around* the contact center: Kairvio speaks one generic webhook
dialect in each direction, and n8n handles the routing, enrichment, and fan-out.

## How it works — Inbound (n8n → Kairvio)

A lead originates anywhere (a website form, Typeform, a Facebook Lead Ad, a
spreadsheet row), n8n shapes it, and n8n's HTTP Request node POSTs it to
Kairvio's universal lead receiver — see
[`inbound/lead-webhook.example.js`](inbound/lead-webhook.example.js). The lead
lands in the unified inbox in real time as a new conversation.

**Key point: this direction needed zero new Kairvio code.** The receiver already
existed and was already built to accept "any HTTP client." n8n is just another
client, authenticated with a per-tenant `Authorization: Bearer <token>` — the
tenant is resolved from the token, never from the request body. The only artifact
on the n8n side is the importable workflow in
[`inbound/n8n-workflow-inbound.json`](inbound/n8n-workflow-inbound.json).

## How it works — Outbound (Kairvio → n8n)

When something happens in Kairvio (`lead.created`, `payment_received`,
`quote_accepted`, `quote_declined`, …), it fire-and-forgets the event to a single
n8n Webhook trigger node, which decides what to do next — see
[`outbound/event-dispatcher.example.js`](outbound/event-dispatcher.example.js)
and [`outbound/n8n-workflow-outbound.json`](outbound/n8n-workflow-outbound.json).

The dispatcher is **~40 lines, env-var-gated, and off by default**: with
`N8N_WEBHOOK_URL` unset it is a pure no-op, so production behaves exactly as it
did before the feature existed. It's **additive** (its own module, no changes to
existing data models), it **never throws** and is bounded by a 3s timeout (a slow
or dead n8n can't hang or fail the originating request), and it **reuses
Kairvio's existing event names** rather than standing up a parallel event system.

## Flagship — AI Instant Lead Responder (both directions, AI in the loop)

The two patterns above combine into something genuinely useful. Service
businesses win or lose jobs on **speed-to-lead**; replying within minutes
dramatically lifts conversion. This workflow closes that gap automatically:

```
New lead → Kairvio fires lead.created → n8n
   → AI node reads the message, classifies intent + urgency, drafts a reply
   → n8n calls BACK into Kairvio to send that reply as an SMS and move the
     lead to "contacted"
   → owner gets a Slack summary ("🔥 hot lead: kitchen remodel — reply sent")
```

This is the important leap: n8n doesn't just *observe* Kairvio events, it
**acts** on them — true bidirectional control. The acting half is a small
token-authed endpoint,
[`ai-lead-responder/actions-webhook.example.js`](ai-lead-responder/actions-webhook.example.js),
that lets a token holder reply to a conversation and advance the lead — scoped
to the token's business, SMS rate-limited, with `lead_status` validated against
the pipeline. The n8n side is
[`ai-lead-responder/n8n-workflow-ai-responder.json`](ai-lead-responder/n8n-workflow-ai-responder.json).

## n8n workflows

All three `.json` files import directly into any n8n instance
(*Workflows → ⋯ → Import from File*) to see the patterns in action:

- [`inbound/n8n-workflow-inbound.json`](inbound/n8n-workflow-inbound.json) —
  Webhook trigger → normalize fields → HTTP Request into Kairvio.
- [`outbound/n8n-workflow-outbound.json`](outbound/n8n-workflow-outbound.json) —
  Webhook trigger ← Kairvio → filter on event type → post to Slack.
- [`ai-lead-responder/n8n-workflow-ai-responder.json`](ai-lead-responder/n8n-workflow-ai-responder.json) —
  Kairvio event → AI triage → auto-reply via Kairvio → Slack the owner.
  (Attach an OpenAI credential to the **AI: Triage Lead** node.)

Set the URLs/tokens (placeholders use `example.com`) to your own instance before
running.

## Design notes

- **Additive, off-by-default.** Outbound is a self-contained module gated by one
  env var; unset = no-op. No existing code path or schema changed.
- **Reused existing primitives.** Inbound reused the already-universal receiver;
  outbound reused Kairvio's existing event vocabulary — no parallel infrastructure.
- **Two clean directional patterns.** One generic inbound contract (token-auth'd
  webhook) and one generic outbound contract (signed event envelope) — n8n owns
  everything tool-specific, so the product stays decoupled from the stack around it.
- **Fails safe.** Outbound never throws and is timeout-bounded; a downstream
  outage can never degrade the Kairvio request that triggered the event.
