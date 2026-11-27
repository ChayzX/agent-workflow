# wordfreq — word frequency command-line tool

Build `wordfreq`, a small, dependency-free Node.js (>= 22) command-line tool that reports the most frequent words in text.

Functional requirements:
- Read text from a file path argument, or from standard input when no path is given.
- Print the top N words with their counts, most frequent first; ties are ordered alphabetically.
- Options: `--top N` (default 10), `--min-length L` (ignore shorter words, default 1), `--json` (machine-readable output: an array of `{ "word", "count" }`).
- Words are case-insensitive and split on anything that is not a Unicode letter, digit or apostrophe inside a word.
- A missing or unreadable file, or an invalid option value, prints a clear error to stderr and exits with code 2.

Non-functional requirements:
- No runtime dependencies; tests use the built-in `node:test` runner and run with `npm test`.
- A README documents installation and usage with examples.
- The core counting logic is a separately importable module with unit tests; the CLI has end-to-end tests that spawn it.
