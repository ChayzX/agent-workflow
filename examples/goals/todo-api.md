# Todo REST API

Build a small JSON REST API for todo items in Node.js (>= 22) with no runtime dependencies (use `node:http` and `node:sqlite`).
Endpoints: create, list (with `?done=true|false` filter), get, update, delete. Validate input (title required, 1–200 chars) and
return proper status codes (400/404/201/204). Persist to a SQLite file whose path comes from the `TODO_DB` environment variable.
Include unit and HTTP integration tests runnable with `npm test`, a README with curl examples, and a health endpoint `/healthz`.
