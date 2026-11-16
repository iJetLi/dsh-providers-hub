# Jet Hub

Sign in to and manage accounts across multiple AI coding services, and bring their models
into the DSH model picker.

One plugin owns four things — **accounts, credentials, model lists, credits** — all from the
settings page, with no slash commands.

## What it does

- **Multi-account pools** — sign the same service in more than once and the plugin picks a
  usable account for you; when one is temporarily unavailable it moves on by itself.
- **Silent credential refresh** — credentials refresh before they expire, so you do not have to
  reopen a browser to sign in again. A failed refresh surfaces a clear error instead of letting
  requests time out quietly.
- **Per-model list toggles** — decide, model by model (or provider by provider), what shows up
  in the model picker.
- **Credits and daily check-in** — one credit panel for every account; providers that support
  check-in can claim the day's allowance in one click.
- **Local OpenAI-compatible gateway** — lets other clients reuse the signed-in accounts
  (loopback only by default).

## Getting started

1. Open **Sidebar → Plugins → Jet Hub**.
2. Click **New account**, choose a provider, and complete its sign-in (QR code, browser
   authorization or a pasted callback link — it differs per provider).
3. Back in the model picker, select a model from that provider and start chatting.

## Security boundaries

- **Credentials stay on this machine** — stored in `~/.dsh/.credentials.yaml`, never uploaded
  and never sent anywhere else.
- **Direct to the official endpoints** — no relay in between; the plugin does not proxy your
  traffic.
- **No way around quotas or risk controls** — rate limits, risk-control blocks and exhausted
  credits are reported as they are.

## What it is not

- **Not a model service** — it provides no compute, only management of accounts you already have.
- **It does not accept terms on your behalf** — check each provider's terms of service yourself.

## Where to read more

| You want | Read |
|---|---|
| Install, configuration, the full provider list | `README.md` (shipped) |
| Per-provider protocol details, measurements and incident history | `docs/implementation-notes.md` and `docs/agent-notes/` **in the source repository — not shipped** |
| The contract for a plugin page's settings section | `docs/plugin-detail-settings-spec.md` **in the source repository — not shipped** |

> This file and `README.md` are the **only** two documents that ship in the npm package;
> everything else under `docs/` lives in the source repository only.
