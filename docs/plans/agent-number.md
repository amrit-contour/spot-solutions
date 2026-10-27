# Plan: an "agent" WhatsApp number next to your own

Status: research note. Phase 1 (plain text, no buttons) is built on whatsapp-web.js, and so are the comic commands that came after it (rooms, spots, regulars, asks, alerts); see [../agent.md](../agent.md). The Cloud API prototype below is still the route to real buttons and is not built. 26 October 2026.

## Idea

Each account links two WhatsApp numbers:

- **Your number** (today): comics message you, you reply, Nothing BOT Curating reads and drafts. Personal chats stay personal.
- **An agent number** (new, optional): a business number that talks to *you*. It asks "Did the Monday mic happen?", reminds you of ask windows for other rooms, and takes updates from you ("Bloom moved Thursday to 9 PM") and turns them into changes in the app. Because it's a business number, it can send real buttons and lists.

## What we tested

From a normal account through whatsapp-web.js (26 Oct): formatting, polls and location pins arrive; buttons and list menus are accepted by WhatsApp and then dropped.

## The catch: the Business *app* doesn't unlock buttons

Buttons and lists belong to the **WhatsApp Business Platform (Cloud API)**, Meta's official API. Linking the WhatsApp Business *app* the same way we link your personal number (QR scan, whatsapp-web.js) behaves like any other account: no buttons. So the agent has to use the Cloud API.

What the Cloud API gives:

- Reply buttons (up to 3), lists (up to 10 rows), call-to-action buttons, all official.
- Webhooks for replies and taps, so a Cloud Function can handle them. No browser and no server laptop needed for the agent.
- Free-form messages (including buttons) are free inside the 24-hour window after *you* message the agent.
- Messages the agent starts (a 10 AM "did the mic happen?") need a pre-approved **template** and are billed per message (utility rates in India are fractions of a rupee; check Meta's rate card).

What it costs to set up:

- A Meta Business account and a WhatsApp Business Platform app. Business verification may be needed for higher limits.
- A phone number for the agent. Meta also offers ways to use a Business app number with the API; check the current rules before picking a number.
- Templates approved by Meta for each kind of message the agent starts.

## Why it's worth it (for you, the curator)

- One-tap answers: "Mic happened?" [Yes] [No]; "Thursday spot at X opens now" [Ask now] [Skip]; "3 people asked for Monday" [Open lineup].
- Your personal chat with yourself stops being the inbox for the app.
- It's the natural home for the "asking other rooms" reminders (docs/plans/asking-rooms.md).
- Comics still talk to your real number, so nothing changes for them.

## Suggested first step

A small prototype: one Cloud API test number, a webhook Cloud Function, and the mic check moved to it with Yes/No buttons. If that feels good, move reminders and room asks to it.

## Sources

- Meta, interactive reply buttons: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
- Meta, interactive list messages: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages
- Meta, pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
