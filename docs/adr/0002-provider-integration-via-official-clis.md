# ADR-0002: Integrate providers through their official CLIs (`claude -p`, `codex exec`, `codex app-server`)

Status: Accepted (2026-11-27)

## Context
The operator's personal subscriptions must be used through officially supported mechanisms only, with no token
extraction, no credential proxies and no silent API billing. The integration needs non-interactive execution, structured
output, session ids and resume, streaming events, model and reasoning selection, sandboxing, and usage-limit signals.

## Evidence (captured live in this environment, fixtures in `test/fixtures/`)
- **Claude Code 2.1.332**, `claude -p --output-format stream-json --verbose`:
  - emits `system/init` (including `apiKeySource`, which is `"none"` under subscription OAuth),
    `rate_limit_event` (with `resetsAt` in epoch seconds and per-window `utilization` for `five_hour` and `seven_day`),
    and `result` (with `structured_output` under `--json-schema`, plus usage and a cost estimate);
  - `--resume <id>` keeps the session id.
- **Codex CLI 0.172.0**, `codex exec --json`:
  - emits `thread.started{thread_id}` and `turn.completed{usage}` / `turn.failed{error.message}`;
  - `codex exec … resume <id> -` resumes a thread;
  - `--output-schema` gives structured output, and `-s read-only|workspace-write` selects the built-in sandbox.
- **`codex app-server`** (JSON-RPC over stdio): `account/read` returns the account type and plan, and
  `account/rateLimits/read` returns `ordinaryUsageAllowed`, the primary (300 min) and secondary (10080 min) windows,
  `usedPercent` and `resetsAt`. These calls cost **no model usage**. A live read at 04:10 UTC returned 100% used with a
  reset at 07:08:04, matching the exec message "try again at 7:08 AM".

## Options
1. Official CLIs, unmodified (chosen).
2. The Claude Agent SDK / Codex SDK. Anthropic's docs direct products built on the Agent SDK to use API-key
   authentication, and subscription OAuth is intended for ordinary use of Claude Code itself. Using the CLI keeps
   authentication entirely inside the vendor binary.
3. Direct HTTP to model APIs. That is API billing, so it is excluded unless spending is explicitly authorized.

## Decision
Use adapters that spawn the unmodified CLIs with scrubbed environments, prompts sent over stdin, JSON-schema outputs,
native resume, and provider-reported rate-limit data. A capability descriptor per adapter declares what it supports.
For example, Claude has no usage-free capacity probe, so its capacity is learned from `rate_limit_event`. Billing guards
abort a run when Claude reports `apiKeySource ≠ none` or Codex reports an `apiKey` account, unless
`allowApiKeyBilling` is set.

## Consequences
- **Codex output:** Codex requires strict schemas (all properties required, `additionalProperties: false`), so they
  are transformed automatically.
- **Claude limits:** the interactive auto-continue after usage limits is not offered in `-p` mode, so the supervisor
  manages continuation. Claude's `CLAUDE_CODE_RETRY_WATCHDOG` is used only for short waits (≤ 10 minutes by default),
  so long waits free the slot for failover.
- **Policy:**
  - Driving the unmodified CLI with one's own subscription on one's own server is the documented supported case. Whether
    heavy 24/7 automation counts as "ordinary individual use" is the operator's judgement; see `docs/providers.md`.
  - ChatGPT-managed Codex auth for headless trusted runners is documented by OpenAI as an advanced setup.
