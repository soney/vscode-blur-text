export type BlurStyle = 'blur' | 'redact';

/** Which part of a regex match to hide: whole match, a group index, or a named group. */
export type GroupSelector = number | string;

/** A fully normalized rule. Raw config entries are looser; see `normalizeRule`. */
export interface BlurRule {
  name?: string;
  pattern: string;
  regex: boolean;
  flags: string;
  groups: GroupSelector[];
  caseSensitive: boolean;
  wholeWord: boolean;
  languages?: string[];
  files?: string;
  enabled: boolean;
  style?: BlurStyle;
  blurRadius?: number;
}

const RULE_DEFAULTS = {
  regex: false,
  flags: '',
  groups: [0],
  caseSensitive: true,
  wholeWord: false,
  enabled: true,
} as const;

/**
 * Accepts either a bare string (literal match) or a partial rule object, and fills
 * in the defaults. Returns undefined for entries that can't produce a match.
 */
export function normalizeRule(raw: unknown): BlurRule | undefined {
  if (typeof raw === 'string') {
    if (raw.length === 0) {
      return undefined;
    }
    return { ...RULE_DEFAULTS, groups: [0], pattern: raw };
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const o = raw as Record<string, unknown>;
  const pattern = typeof o.pattern === 'string' ? o.pattern : undefined;
  if (!pattern) {
    return undefined;
  }

  return {
    ...RULE_DEFAULTS,
    pattern,
    name: typeof o.name === 'string' ? o.name : undefined,
    regex: o.regex === true,
    flags: typeof o.flags === 'string' ? o.flags : '',
    groups: normalizeGroups(o.group),
    caseSensitive: o.caseSensitive !== false,
    wholeWord: o.wholeWord === true,
    languages: Array.isArray(o.languages)
      ? o.languages.filter((l): l is string => typeof l === 'string')
      : undefined,
    files: typeof o.files === 'string' ? o.files : undefined,
    enabled: o.enabled !== false,
    style: o.style === 'blur' || o.style === 'redact' ? o.style : undefined,
    blurRadius: typeof o.blurRadius === 'number' ? o.blurRadius : undefined,
  };
}

function normalizeGroups(raw: unknown): GroupSelector[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [0] : [raw];
  const groups = list.filter(
    (g): g is GroupSelector => typeof g === 'number' || typeof g === 'string'
  );
  return groups.length > 0 ? groups : [0];
}

/** A label for error messages and the rules hover. */
export function describeRule(rule: BlurRule): string {
  if (rule.name) {
    return rule.name;
  }
  const shown = rule.pattern.length > 40 ? `${rule.pattern.slice(0, 40)}…` : rule.pattern;
  return rule.regex ? `/${shown}/` : `"${shown}"`;
}
