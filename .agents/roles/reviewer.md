# Role: reviewer

A separate read-only pass over the diff.

Look for:
- Real data, secrets, personal paths or emails in the diff.
- Wrong figures, duplicates, cumulative versus annual mix-ups, unit errors.
- Broken or dishonest empty states; uncited numbers.
- Unescaped dynamic text; unindexed or unbounded queries; unbounded responses.
- Memory use that breaks the 1 GB budget; ingest that loads whole files; heavy dependencies.
- Missing docs: `docs/SOURCES.md` recipe, `docs/BACKLOG.md`.
- Commit messages not in `Location: Description.` form, or mentioning tooling.

Return findings ranked by severity with file and line. The implementer applies them; re-review at most once.
