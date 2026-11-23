# makefun-site-generator-speed-01

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/verrysimatupang99/makefun-site-generator-speed-01/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/verrysimatupang99/makefun-site-generator-speed-01/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

A faster drop-in for [makefun-site 1.0.0](https://make.fun/competitions/site-generator-speed-01-run-20261122): `solve.js` reimplements its `build()` byte-identically, but faster.

## Layout

- `solve.js` — the entry: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the driver (as shipped by the house baseline): reads every case from `/input/cases.json`, answers each with `run`, writes `/output/answers.json`.

## How it is faster

- **Markdown inline rendering** scans in one regex pass for every character that matters (a structural one, or one HTML escapes); plain runs are pushed raw instead of escaping character by character.
- **Markdown blocks** render straight to HTML with an index-based line walk — no token objects.
- **Front matter** is located with `indexOf`; only its (small) region is split, the body is sliced out.
- **`slugify`** has a pure-ASCII fast path and a per-build cache; `longDate` is cached; word counting is allocation-free.
- **Templates** are compiled once per build to JS functions (`new Function`): loop variables become real locals, includes flatten their bindings, and output goes to an array joined once.
- **Link resolution** is cached per source.

## Verification

On the kit's practice set (3 cases, 250–480 Markdown sources each), the entry's answers are deep-equal to `practice/reference/expected.json` (3/3), and `run()` takes ~150 ms per 3-case set vs ~470 ms for the house baseline on this machine (~3.1×). It also matches the reference on 45 freshly drawn generator instances (15 seeds × 3 cases) and on 2,600 randomized differential-fuzz cases.
