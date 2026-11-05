# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Continuous integration, release workflow and release helper.
- Pull-model updater, systemd units and first-time installer for the production server.
- Operations, releasing and AWS migration documentation.

## [0.1.1]

### Changed
- Installer accepts `--python` (default: first Python 3.12 or newer found), links `/usr/local/bin/estado-aberto-python` and no longer enables the timers unless `--enable-timers` is given.
- Updater, ingest queue runner and the daily service use `estado-aberto-python`; shell scripts honour `ESTADO_ABERTO_PYTHON`.
- Operations and AWS migration docs describe Amazon Linux 2023 (Python 3.12, system Node, poppler-utils, existing swap, timer enablement order).

### Fixed
- The post-update doctor step no longer fails on hosts whose `python3` is older than 3.12.

## [0.1.0]

### Added
- Initial public code base: web server, ingest tools, sample data generator and smoke test.
