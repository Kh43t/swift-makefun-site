[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Kh43t/swift-makefun-site/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Kh43t/swift-makefun-site/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

# Swift makefun-site

A faster drop-in for [makefun-site 1.0.0](https://make.fun/c/site-generator-speed-01-run-20261122), built for the [make.fun "Build a static site faster" bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122). It answers byte-for-byte exactly as makefun-site 1.0.0 does on every case, with far less CPU time.

## How it is faster

- One scan per character: a single-pass Markdown block renderer with an inline parser that works on string ranges (no token objects, no per-character regex escaping).
- Bulk HTML escaping: plain-text runs are copied once, never escaped character by character.
- Cached slugs and long dates, with an ASCII fast path for the slug rule (no Unicode normalisation when the text is pure ASCII).
- Front matter parsed with index scans instead of a line split plus a regex per line.
- Templates parsed once and compiled to render functions that build one string each (string concatenation, no intermediate arrays), with page and card records built once per source.

## Layout

- `solve.js` — the whole solver: `run(input)` returns makefun-site 1.0.0's output tree for one case's input.
- `main.ts` — the entry program: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.

## License

MIT — see `LICENSE`.
