import type { BlurRule, GroupSelector } from './rules';
import { describeRule } from './rules';

export interface CompiledRule {
  rule: BlurRule;
  regexp: RegExp;
  /** True when the engine gave us match.indices, so group offsets are exact. */
  hasIndices: boolean;
}

export interface CompileResult {
  compiled: CompiledRule[];
  errors: { rule: BlurRule; message: string }[];
}

/** Half-open [start, end) character offsets into a document. */
export interface OffsetRange {
  start: number;
  end: number;
  styleKey: string;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(text: string): string {
  return text.replace(REGEX_SPECIALS, '\\$&');
}

/**
 * `\b` only asserts a boundary next to a word character, so `\bsk-abc\b` would never
 * match. Only add the assertion on ends where it can actually hold.
 */
function applyWholeWord(source: string, original: string): string {
  const isWord = (c: string | undefined) => c !== undefined && /\w/.test(c);
  const prefix = isWord(original[0]) ? '\\b' : '';
  const suffix = isWord(original[original.length - 1]) ? '\\b' : '';
  return `${prefix}${source}${suffix}`;
}

function buildFlags(rule: BlurRule, withIndices: boolean): string {
  const flags = new Set<string>(['g']);
  if (withIndices) {
    flags.add('d');
  }
  if (!rule.caseSensitive) {
    flags.add('i');
  }
  for (const f of rule.flags) {
    if (f !== 'g' && f !== 'd') {
      flags.add(f);
    }
  }
  return [...flags].join('');
}

export function compileRules(rules: readonly BlurRule[]): CompileResult {
  const compiled: CompiledRule[] = [];
  const errors: { rule: BlurRule; message: string }[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.pattern.length === 0) {
      continue;
    }

    let source = rule.regex ? rule.pattern : escapeLiteral(rule.pattern);
    if (rule.wholeWord && !rule.regex) {
      source = applyWholeWord(source, rule.pattern);
    }

    try {
      compiled.push({ rule, regexp: new RegExp(source, buildFlags(rule, true)), hasIndices: true });
    } catch {
      // Either the pattern is bad or the runtime predates the `d` flag; tell them apart.
      try {
        compiled.push({
          rule,
          regexp: new RegExp(source, buildFlags(rule, false)),
          hasIndices: false,
        });
      } catch (e) {
        errors.push({
          rule,
          message: `${describeRule(rule)}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  return { compiled, errors };
}

interface MatchIndices extends Array<[number, number] | undefined> {
  groups?: Record<string, [number, number] | undefined>;
}

/**
 * Resolve a group selector to offsets. Prefers `match.indices`; falls back to searching
 * the group's text inside the match, which is right except for pathological patterns
 * where the same substring appears more than once.
 */
function resolveGroup(
  match: RegExpExecArray,
  selector: GroupSelector,
  out: OffsetRange[],
  styleKey: string
): void {
  if (selector === 0) {
    push(out, match.index, match.index + match[0].length, styleKey);
    return;
  }

  const indices = (match as RegExpExecArray & { indices?: MatchIndices }).indices;
  const pair =
    typeof selector === 'number' ? indices?.[selector] : indices?.groups?.[selector];
  if (pair) {
    push(out, pair[0], pair[1], styleKey);
    return;
  }

  const text = typeof selector === 'number' ? match[selector] : match.groups?.[selector];
  if (!text) {
    // Group did not participate in the match (common with alternations) — nothing to hide.
    return;
  }
  const relative = match[0].indexOf(text);
  if (relative >= 0) {
    push(out, match.index + relative, match.index + relative + text.length, styleKey);
  }
}

function push(out: OffsetRange[], start: number, end: number, styleKey: string): void {
  if (end > start) {
    out.push({ start, end, styleKey });
  }
}

export interface ScanLimits {
  maxMatchesPerRule: number;
}

/** Collect every offset range that should be hidden in `text`. */
export function findRanges(
  text: string,
  compiled: readonly CompiledRule[],
  styleKeyOf: (rule: BlurRule) => string,
  limits: ScanLimits
): OffsetRange[] {
  const out: OffsetRange[] = [];

  for (const { rule, regexp } of compiled) {
    const styleKey = styleKeyOf(rule);
    regexp.lastIndex = 0;
    let count = 0;
    let match: RegExpExecArray | null;

    while ((match = regexp.exec(text)) !== null) {
      for (const selector of rule.groups) {
        resolveGroup(match, selector, out, styleKey);
      }
      // A zero-length match leaves lastIndex where it was; step past it or we spin.
      if (match.index === regexp.lastIndex) {
        regexp.lastIndex++;
      }
      if (++count >= limits.maxMatchesPerRule) {
        break;
      }
    }
  }

  return out;
}

/**
 * Sort and merge overlapping/adjacent ranges. Overlapping ranges from different styles
 * collapse into the first one's style, which keeps blur filters from stacking and
 * darkening the text.
 */
export function mergeRanges(ranges: OffsetRange[]): OffsetRange[] {
  if (ranges.length <= 1) {
    return ranges;
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: OffsetRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end && range.styleKey === last.styleKey) {
      last.end = Math.max(last.end, range.end);
    } else if (last && range.start < last.end) {
      // Different styles overlap: keep the earlier style, only extend past its end.
      if (range.end > last.end) {
        merged.push({ start: last.end, end: range.end, styleKey: range.styleKey });
      }
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}
