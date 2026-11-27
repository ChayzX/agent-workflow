# ADR-0008: Dashboard served by the supervisor process with vanilla JS and strict CSP

Status: Accepted (2026-11-27)

## Decision
- **Server:** `node:http` serves a static SPA (no build step, no framework) and a JSON API. The UI reads real persisted
  state only.
- **Progress** is computed as verified mandatory requirements / mandatory requirements.
- **Authentication:** a random token is generated at setup and only its hash is stored. Login creates a session cookie
  (HttpOnly, SameSite=Strict, server-side hash, expiry). Failed logins are rate-limited.
- **CSRF and headers:**
  - State changes need an `X-Orchestrator-CSRF` header and a same-origin `Origin`.
  - The CSP is `script-src 'self'` with no inline code.
  - All agent-derived text is rendered with `textContent` only.
- **Binding:** loopback by default. Binding elsewhere requires a token, and TLS should be terminated in front.
- **Separation:** controls are queued as supervisor commands. Closing the browser never affects execution.
