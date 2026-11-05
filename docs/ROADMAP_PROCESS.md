# Roadmap process

## Where things live

- `docs/ROADMAP.md`: the public roadmap page (Em curso, A seguir, Feito).
- `docs/BACKLOG.md`: the working list. `[ ]` open, `[~]` in progress, `[x]` done, with notes on gaps and next steps.
- GitHub issues: proposals and discussion, from the issue templates.

## Proposing an item

1. Search the backlog and open issues for duplicates.
2. Open a "Roadmap suggestion" issue, or "New data source" when it needs a source. State the public question it answers and the section.
3. For data: verify the URL with `curl`, check `robots.txt` and terms, record licence, format, update frequency and an estimate of size, time and RAM. Never attach data.
4. A maintainer triages: accept (a backlog line is added, with the source URL), ask for changes, or decline with a reason.

## Working an item

1. Claim it in the issue. Mark the backlog line `[~]`.
2. Build it following `docs/MODULES.md` and the checks in `CONTRIBUTING.md`.
3. In the PR: tick the backlog line, record what shipped and what was verified, and list remaining gaps as new backlog lines.
4. When merged, move it to "Feito" in `docs/ROADMAP.md` in plain Portuguese.

## Prioritisation

Data coverage of decisions, votes, laws, reports and audits first; then quality and honesty fixes to existing pages; then presentation. Anything that breaks the resource budget or the data policy is declined.
