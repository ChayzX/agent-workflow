# ADR-0001: TypeScript on Node.js ≥ 22.13 with built-in SQLite; zero runtime dependencies

Status: Accepted (2026-11-27)

## Context
The supervisor must run for weeks on a modest Debian server, survive reboots, and be easy to install. Both provider CLIs are
Node-distributed (`@anthropic-ai/claude-code`, `@openai/codex`), so Node is already required on the host.

## Options
1. TypeScript/Node + `node:sqlite` (built in since 22.5, unflagged since 22.13). No native build, no ORM.
2. TypeScript/Node + `better-sqlite3`. Mature, but a native addon that needs build tools and can break on Node upgrades.
3. Python + SQLite. Adds a second runtime on the host.
4. Go/Rust single binary. Best distribution, but slower to build and no in-ecosystem access to provider SDK types.
5. Postgres, Redis or a message broker. Unnecessary operational weight for a single-node supervisor.

## Decision
Option 1, with WAL mode, `BEGIN IMMEDIATE` transactions for atomic claims, a schema migration table, and **zero runtime npm
dependencies**. HTTP, ZIP, JSON-schema validation and the GitHub client are small in-repo modules on Node built-ins.

## Consequences
- Install is "Node + git". Release ZIPs ship a prebuilt `dist/`, so no `npm install` is needed to run.
- `node:sqlite` still prints an ExperimentalWarning, which the launcher suppresses. The API is stable enough for this use;
  revisit if it changes.
- No supply-chain exposure from runtime packages. Dev-only dependencies are `typescript` and `@types/node`.
