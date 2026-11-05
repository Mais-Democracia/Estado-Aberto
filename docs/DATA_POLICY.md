# Data policy

This is the first and strictest rule of the project.

## The rule

No real data is ever committed, attached to a pull request or release, or uploaded to any server.

The repository ships only:

- code (server, client, ingest jobs, tools);
- schemas (table definitions inside the ingest jobs);
- synthetic sample generators (`tools/make_sample.py`);
- documentation.

`data/` is gitignored and stays that way. Databases, raw downloads, caches, CSV/XLSX/PDF extracts, screenshots that contain real records at scale and database dumps are all "data".

## How people get data

Anyone who needs data runs the ingest tools against the public sources themselves:

```sh
python3 tools/bootstrap.py
python3 ingest/run_all.py [job]
```

## What a contributor does instead of sending data

If you build something locally that needs a new source, you contribute the code plus a documented recipe in the pull request and in `docs/SOURCES.md`:

- what to download and from which URL;
- how to run it (command, job name, manifest entry);
- licence and robots.txt / terms-of-service status, with the date checked;
- expected size, time and peak RAM.

The production server updates itself by running the released tools. Contributors never send data to it, and no agent or contributor has a route to do so.

## Sources

Licences and terms are listed per source in `docs/SOURCES.md`. Respect robots.txt and each site's terms, send the project user agent, cache downloads, sleep between requests to one host, and never bypass blocks, logins, paywalls or CAPTCHAs. If a source is blocked, say so on the page and in `docs/SOURCES.md`.

## Fixtures

Tests and demos use synthetic data only. Synthetic records must be obviously invented and must not use real people's names, NIFs or identifiers.

## If real data was committed

Stop, do not push, and tell the maintainers. History is rewritten before anything is published.
