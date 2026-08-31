# Changelog

## 0.2.0

- Pastes and other multi-character inserts redecorate immediately instead of waiting
  out the typing debounce, so a pasted secret is no longer left briefly readable.
- VS Code settings files are no longer blurred. They hold the patterns themselves, so
  blurring them smudged the rules you were editing. Controlled by
  `blurText.excludeConfigFiles`, with `blurText.excludeFiles` for anything else.
- Presets are toggled as checkboxes in the settings UI rather than an id list. The
  earlier array form is still accepted.

## 0.1.0

Initial release.

- Blur or redact text matching literal strings or regular expressions.
- Blur only part of a regex match via numbered, named, or multiple capture groups.
- Built-in pattern presets for common secrets, plus `.env` values and secret-looking
  assignments.
- Per-rule `languages` and `files` scoping, and per-rule style overrides.
- Toggle, peek, and "blur selection" commands, with a status bar indicator.
- Optional reveal-at-cursor so blurred text stays editable.
- Runs in both VS Code desktop and VS Code for the Web.
