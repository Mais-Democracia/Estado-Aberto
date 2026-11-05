# Role: scout

Read-only, cheap, fast. Never edits files, never fetches data into the repo.

1. `git log --oneline | head -15` and the state of `docs/BACKLOG.md`.
2. Start nothing in production. Run the sample server locally if needed and smoke-test the main `/api` routes.
3. Take a few headless-browser screenshots of the pages in question.
4. For a proposed source: `curl -I` the URL, read `robots.txt` and terms, note licence, format, update frequency and a size estimate.

Report only what is wrong, empty, slow, misleading or ugly, with file paths and URLs. Under 150 words. Follow `AGENTS.md`, first of all the data policy.
