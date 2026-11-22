# Build note — mend (hidden-spec-cli-01-run-20261122)

Entry: `main.ts` (Node 22, stdlib only, run as `node main.ts [options] [PATCH]`).
Starter sections 1–4, 9, 10 kept as-is; sections 5–8 implemented in this session:
- §5 three-tier matching (exact / trailing-trim / full-trim), tier-2 re-indentation,
  context lines written as the file's own lines, `--strict` = tier 0 only.
- §6 unified diffs: sections, `---`/`+++` (incl. tab timestamps, `/dev/null`, `a/`/`b/`
  stripping), `rename from/to`, `new/deleted file mode`, hunks, nearest-occurrence
  selection (`A-1+d`, ties earlier), empty-O insertion, `\ No newline` handling.
- §7 SEARCH/REPLACE blocks: path detection (nearest non-blank, non-fence line,
  else previous block's path), `ambiguous` on >1 occurrence at the found tier.
- §8 V4A: Begin/End Patch checks, Add/Delete/Update, `*** Move to:`, anchors
  (cursor moves past the anchor line), `*** End of File` chunks, trailing blank
  lines stripped from sections.
- §2 `R old -> new` lines for successful moves (sorted by `<new>`), replacing
  the pair's `D`/`A` lines; write phase in byte-sorted path order.

## Verification

- Practice set (`node check.ts <kit>/program/generator/practice.json`):
  **100 of 100 passed, practice score 1000.** Run twice with identical result
  (deterministic). Baseline starter was 24/100.
- Extra edge batteries (scratch, `/tmp/mend-edge.mjs`, `/tmp/mend-edge2.mjs`):
  **45/45 + 23/23** — usage errors, `--check` dry-run, unsafe paths, empty
  patches/hunks, CRLF, no-trailing-newline, chained moves, move-then-modify,
  rename without `---`/`+++`, `new/deleted file mode`, V4A anchors, SR
  inheritance/ambiguity, `--` separator, atomicity on failure.
- Failing checks: **none** in practice or edge batteries.

## How to run the checks

```
node check.ts <kit>/program/generator/practice.json
node check.ts <kit>/program/generator/practice.json u-offset s-basic   # subset
```

## Known judgement calls (SPEC sentences with more than one reading)

- V4A anchor is a line *before* the chunk's lines: the cursor moves past it and
  O is searched after it (an anchor equal to O's first line yields `no-match`).
  Confirmed by all 4 practice anchor cases.
- An end-of-file V4A chunk takes the *first* occurrence at/after the cursor and
  requires it to end at the file's last line, else `no-match`.
- Chained moves (A→B then B→C) print `D A` + `A C`, not `R A -> C` (§2's R
  condition is per move edit).
- An empty unified hunk whose insertion point is at EOF applies the §6
  final-break rule literally (result ends with a line break unless a `\` line
  follows its last context/`+` line).

## Repo

- Local git repo, author `zesty-orca-73 <zesty-orca-73@make.fun>`.
- Commit hash: see `git log` (this note is written before the final commit;
  the build commit is the HEAD after it).
- `runner.ts` untouched; the `MAKEFUN_ENV_URL` hand-over at the end of
  `main.ts` untouched.
- No GitHub repo created, no submit, make.fun API untouched, no API key used.
