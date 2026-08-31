import type { BlurRule } from './rules';

/** Shorthand for building preset rules without repeating every default. */
function rule(partial: Partial<BlurRule> & { pattern: string; name: string }): BlurRule {
  return {
    regex: true,
    flags: '',
    groups: [0],
    caseSensitive: true,
    wholeWord: false,
    enabled: true,
    ...partial,
  };
}

/**
 * Opt-in pattern packs, enabled by id through the `blurText.presets` setting.
 * Keep ids in sync with the enum in package.json.
 */
export const PRESETS: Record<string, BlurRule[]> = {
  'secret-assignments': [
    rule({
      name: 'secret-assignments',
      // A secret-looking name, then whatever it is assigned to. The optional middle
      // section steps over a type annotation so `token: string = "..."` captures the
      // string and not the type name.
      pattern:
        '(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)["\'`]?\\s*(?::[ \\t]*[\\w$<>\\[\\].|, \\t]{0,60}?[ \\t]*)?[:=]\\s*["\'`]?([^\\s"\'`,;)]+)',
      groups: [1],
      caseSensitive: false,
    }),
  ],
  'dotenv-values': [
    rule({
      name: 'dotenv-values',
      pattern:
        '^\\s*(?:export\\s+)?[A-Za-z_][A-Za-z0-9_]*\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s#]+))',
      flags: 'm',
      groups: [1, 2, 3],
      files: '**/{.env,.env.*,*.env,*.envrc}',
    }),
  ],
  'openai-keys': [rule({ name: 'openai-keys', pattern: 'sk-(?:proj-)?[A-Za-z0-9_-]{16,}' })],
  'anthropic-keys': [rule({ name: 'anthropic-keys', pattern: 'sk-ant-[A-Za-z0-9_-]{16,}' })],
  'aws-keys': [
    rule({ name: 'aws-keys', pattern: '(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Za-z0-9]{16}' }),
  ],
  'github-tokens': [
    rule({
      name: 'github-tokens',
      pattern: 'gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}',
    }),
  ],
  'google-api-keys': [rule({ name: 'google-api-keys', pattern: 'AIza[0-9A-Za-z_-]{35}' })],
  'slack-tokens': [rule({ name: 'slack-tokens', pattern: 'xox[baprse]-[A-Za-z0-9-]{8,}' })],
  'stripe-keys': [rule({ name: 'stripe-keys', pattern: '[srp]k_(?:live|test)_[A-Za-z0-9]{10,}' })],
  'bearer-tokens': [
    rule({
      name: 'bearer-tokens',
      pattern: 'bearer\\s+([A-Za-z0-9\\-._~+/]{8,}={0,2})',
      groups: [1],
      caseSensitive: false,
    }),
  ],
  jwt: [
    rule({
      name: 'jwt',
      pattern: 'eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}',
    }),
  ],
  'private-key-blocks': [
    rule({
      name: 'private-key-blocks',
      pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
    }),
  ],
  emails: [
    rule({ name: 'emails', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' }),
  ],
  'ip-addresses': [
    rule({
      name: 'ip-addresses',
      pattern:
        '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b',
    }),
  ],
  uuids: [
    rule({
      name: 'uuids',
      pattern:
        '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b',
    }),
  ],
};

/**
 * The setting is an object of booleans so the settings UI renders it as checkboxes
 * (`{"openai-keys": true}`). An array of ids is still accepted, since that was the
 * earlier shape and is the more natural thing to hand-write in JSON.
 */
export function enabledPresetIds(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((id): id is string => typeof id === 'string');
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([id]) => id);
  }
  return [];
}

export function presetRules(ids: readonly string[]): BlurRule[] {
  const out: BlurRule[] = [];
  for (const id of ids) {
    const preset = PRESETS[id];
    if (preset) {
      out.push(...preset);
    }
  }
  return out;
}

export function unknownPresets(ids: readonly string[]): string[] {
  return ids.filter((id) => !(id in PRESETS));
}
