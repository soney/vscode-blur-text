# Changelog

## 0.1.0

Initial release.

- Blur or redact text matching literal strings or regular expressions.
- Blur only part of a regex match via numbered, named, or multiple capture groups.
- Built-in pattern presets for common secrets, plus `.env` values and secret-looking
  assignments, toggled as checkboxes in the settings UI.
- Per-rule `languages` and `files` scoping, and per-rule style overrides.
- Toggle, peek, and "blur selection" commands, with a status bar indicator.
- Optional reveal-at-cursor so blurred text stays editable.
- Pastes and other multi-character inserts redecorate immediately instead of waiting
  out the typing debounce, so a pasted secret is not left readable.
- VS Code settings files are excluded by default, since they hold the patterns
  themselves; `blurText.excludeFiles` scopes out anything else.
- Runs in both VS Code desktop and VS Code for the Web.
