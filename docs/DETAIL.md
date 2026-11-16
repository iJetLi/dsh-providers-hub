# Jet Hub

Sign in to and manage accounts across multiple AI coding services, and bring their models
into the DSH model picker.

One plugin owns four things — **accounts, credentials, model lists, credits** — all from the
settings page, with no slash commands.

## What it does

- **Multi-account pools** — sign the same service in more than once and the plugin picks a
  usable account for you. **Providers that support request-level account switching** move to
  the next account when one is temporarily unavailable (rate limit, cooldown, exhausted
  credits), so you do not switch by hand.
- **Silent credential refresh** — **providers with a refresh endpoint** renew credentials
  before they expire, so you do not have to reopen a browser. A few providers have no refresh
  endpoint (it follows from how you sign in — browser cookies or a QR code, for example), and
  there you sign in again once their credentials expire; the plugin says so in the error text
  instead of letting requests time out quietly.
- **Per-model list toggles** — decide, model by model (or provider by provider), what shows up
  in the model picker.
- **Credits and daily check-in** — one credit panel for the **providers that expose usable
  credits** (providers without any are simply absent from the panel). Providers that support
  check-in can claim the day's allowance in one click, and **automatic check-in is on by
  default** — you can turn it off in settings.
- **Local OpenAI-compatible gateway** — lets other clients reuse the signed-in accounts
  (loopback only by default; the "allow LAN access" switch in settings binds a non-loopback
  address, so only enable it on a network you trust).

## Getting started

1. Open **Jet Hub** from the main navigation — the row appears once the plugin is enabled. If
   that row is hidden, the plugin's detail page has a settings card whose "panel entry" can be
   pointed at the settings page.
2. Click **New account**, choose a provider, and complete its sign-in (QR code, browser
   authorization or a pasted callback link — it differs per provider).
3. Back in the model picker, select a model from that provider and start chatting.

## Security boundaries

- **Credentials stay on this machine** — they are held by DSH's host credential store (on this
  machine that is `~/.dsh/.credentials.yaml`); the plugin never uploads or forwards them.
- **The plugin's own requests go straight to the official endpoints** — there is no third-party
  relay between you and the upstream. The one exception is the **local gateway you turn on
  yourself**: it forwards your own machine's clients to your signed-in accounts.
- **No quota or billing deception** — it never fabricates credits, never farms allowance on your
  behalf, and never sidesteps account-level limits (rate limits, cooldowns and order checks are
  honoured as they come). When something is refused, it reports why rather than pretending to
  succeed.

## What it is not

- **Not a model service** — it provides no compute, only management of accounts you already have.
- **It does not accept terms on your behalf** — check each provider's terms of service yourself.

## Where to read more

| You want | Read |
|---|---|
| Install, configuration, the full provider list | `README.md` (shipped) |
| Per-provider protocol details, measurements and incident history | `docs/agent-notes/` **in the source repository — not shipped** |
| The contract for a plugin page's settings section | `docs/plugin-detail-settings-spec.md` **in the source repository — not shipped** |

> The package ships only `README.md` plus `docs/DETAIL.md` and `docs/DETAIL.zh.md` — two
> documents, one per language. Everything else under `docs/` lives in the source repository
> only.
