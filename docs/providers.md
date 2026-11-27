# Providers

## Capability matrix (as implemented and verified on 2026-11-27)

| Capability | Claude Code 2.1.332 (`claude -p`) | Codex CLI 0.172.0 (`codex exec`, `codex app-server`) |
|---|---|---|
| Non-interactive execution | ✅ `-p`, prompt on stdin | ✅ `exec -`, prompt on stdin |
| Structured result | ✅ `--json-schema` → `structured_output` | ✅ `--output-schema` (strict schema auto-derived) |
| Streaming events | ✅ `stream-json` | ✅ `--json` JSONL |
| Session id | ✅ `--session-id` / `system.init.session_id` | ✅ `thread.started.thread_id` |
| Native resume | ✅ `--resume <id>` (verified live) | ✅ `exec … resume <id> -` (argument parsing verified; live resume pending capacity) |
| Model / reasoning selection | ✅ `--model`, `--effort` | ✅ `-m`, `-c model_reasoning_effort=…` |
| Working directory isolation | ✅ cwd = worktree | ✅ `-C` worktree |
| Execution permissions | read-only tool allowlist / `acceptEdits` + deny rules | `-s read-only` / `-s workspace-write` (network off unless enabled) |
| Cancellation / timeout | ✅ process-group SIGTERM→SIGKILL | ✅ same |
| Auth validation (no model usage) | ✅ `claude auth status` (JSON) | ✅ `codex login status`, `account/read` |
| Usage-limit detection | ✅ `rate_limit_event.status=rejected` with `resetsAt`, plus message parsing | ✅ `account/rateLimits/read` (`ordinaryUsageAllowed`, windows, `resetsAt`), plus "try again at …" parsing |
| Capacity probe without model usage | ❌ (learned from events during runs; canary after reset) | ✅ app-server, every 15 min while available |
| Usage reporting | tokens + provider cost estimate | tokens |
| API-billing guard | `system.init.apiKeySource` must be `none` | `account.type` must be `chatgpt` |

## Authentication (operator does this once on the server)

- **Claude:** `claude login` (Pro/Max subscription), or `claude setup-token`, which Anthropic documents as a one-year
  token for scripts and CI. The orchestrator never reads the token; the CLI handles it.
- **Codex:** `codex login --device-auth` (sign in on any device with the shown code), or copy a trusted `auth.json` as
  described in OpenAI's CI/CD auth guide. Keep one machine per credential copy.
- **Reauthentication:** if either expires, the provider moves to `auth_required`, an approval of type
  `provider_reauthentication` appears, and the provider is restored automatically once `claude auth status` or
  `codex login status` passes.

## Policy notes (read before heavy automation)

- **Anthropic:**
  - Subscription OAuth is intended for ordinary use of Claude Code and native Anthropic apps.
  - Products built on the Agent SDK should use API keys.
  - Signing in to the *unmodified* Claude Code binary with your own subscription is supported, and this orchestrator
    does only that, for your own use.
  - Whether sustained unattended use counts as "ordinary individual usage" under your plan's terms is your judgement.
  - Do not offer this system to other people on your subscription.
- **OpenAI:**
  - API keys are recommended for automation.
  - ChatGPT-managed Codex auth on trusted private runners is documented as an advanced setup, for users who want plan
    limits instead of API billing.
  - Never use it for public or open-source CI.
- **The orchestrator never:**
  - extracts or proxies tokens;
  - bypasses limits;
  - purchases credits or consumes rate-limit reset credits (the app-server's `account/rateLimitResetCredit/consume`
    is deliberately unused);
  - switches to API billing without `providers.<id>.allowApiKeyBilling: true`.

## Model routing defaults

| Complexity | Claude | Codex |
|---|---|---|
| low | haiku | provider default, effort low |
| medium | sonnet | provider default, effort medium |
| high (and plan / security_review / decide / investigate / completion audit) | opus | provider default, effort high |

Override in `config.json` under `providers.<id>.models` and `providers.<id>.effort`. Security reviews never move down
a model tier.

## Adding a provider
Implement `ProviderAdapter` (`src/providers/types.ts`): `capabilities`, `detect`, `checkAuth`, `probeCapacity`,
`execute`. Register it in `src/providers/registry.ts` and add a `providers.<id>` config block. The router, capacity
manager and workflow need no changes.
