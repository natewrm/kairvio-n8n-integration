# Architecture

A deeper one-page look at the two integration patterns. (Companion to the
[README](../README.md).)

## The two flows

```
                          ┌──────────────────────── n8n ────────────────────────┐
  Website form  ───►      │  Webhook   ─►  Normalize  ─►  HTTP Request           │
  Typeform      ───►      │  trigger       fields         (Bearer token)         │
  Facebook Lead ───►      │                                    │                 │
  Sheet row     ───►      │                                    │                 │
                          └────────────────────────────────────┼────────────────┘
                                                                │
                              DIRECTION 1  (n8n → Kairvio)       │  POST /lead-webhook
                              "leads flow IN"                    ▼
                                                  ┌─────────────────────────────────┐
                                                  │             KAIRVIO             │
                                                  │  lead-webhook  ─►  Inbox / CRM  │
                                                  │       │                         │
                                                  │       ▼   dispatchToN8n(event)  │
                                                  │   (payment_received,            │
                                                  │    quote_accepted, …)           │
                                                  └───────┼─────────────────────────┘
                                                          │
                              DIRECTION 2  (Kairvio → n8n)│  POST $N8N_WEBHOOK_URL
                              "events flow OUT"           ▼
                          ┌────────────────────────────────────────────────────────┐
                          │  Webhook  ─►  IF event ─►  Build msg ─►  Slack / Sheets │
                          │  trigger      == type                   / CRM / AI step │
                          └──────────────────────── n8n ───────────────────────────┘
```

Because the outbound event fires from the same code path that ingests an inbound
lead, the two flows form a complete loop: a lead enters Kairvio *through* n8n,
and Kairvio immediately emits `lead.created` *back out* to n8n for routing.

## Direction 1 — Inbound (n8n → Kairvio)

- **Contract:** `POST` JSON `{ name, phone, email, message, source }`, with
  `Authorization: Bearer <webhook_token>`. `phone` is the only required field.
- **Tenant isolation:** the token maps the request to exactly one business. The
  tenant is never read from the request body.
- **Receiver work:** validate + normalize the phone to E.164, find-or-create the
  customer, create/update the conversation, insert the inbound message.
- **Zero new app code:** the receiver was already generic ("any HTTP client"), so
  integrating n8n meant building an n8n workflow, not changing the product.

## Direction 2 — Outbound (Kairvio → n8n)

- **Contract (event envelope):**
  ```json
  {
    "event": "payment_received",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "source": "kairvio",
    "data": { "invoice_id": "…", "amount_paid": 250.0, "fully_paid": true }
  }
  ```
- **Events:** names reuse Kairvio's existing internal vocabulary
  (`lead.created`, `payment_received`, `quote_accepted`, `quote_declined`, …),
  each emitted right next to where Kairvio already logs that event.
- **Safety:** gated by `N8N_WEBHOOK_URL` (off by default → no-op), optional
  `X-Kairvio-Signature` shared-secret header, 3s timeout, never throws.
- **Decoupling:** Kairvio targets one n8n webhook; n8n owns all tool-specific
  routing, so the product never depends on Slack/Sheets/CRM directly.

## What's NOT in this repo

This is a **sanitized excerpt** of integration code from a larger production
codebase, intended to document the patterns — not a runnable copy of the app. It
deliberately excludes:

- The production application, its database schema/migrations, and RLS policies.
- Real hostnames, tokens, API keys, and any customer or tenant data
  (placeholders use `example.com`).
- Kairvio-internal helpers referenced by the examples (Twilio SMS notifications,
  plan/feature gating, phone-number provisioning), stubbed here with comments.
- The full set of event emission call sites; a representative subset is shown.
