/**
 * PromptGuard
 *
 * Utilities for safely handling external content in agent pipelines.
 *
 * - `wrapExternalContent`: Tags external user content with untrusted XML markers
 *   so agents can distinguish it from trusted pipeline instructions.
 * - `detectInjectionSignals`: Scans content for known prompt injection patterns
 *   and returns structured signal objects (detection only — does NOT block).
 */

export type ExternalContentSource = 'task' | 'bid' | 'submission' | 'comment';

export interface InjectionSignal {
  /** Human-readable description of the pattern that triggered */
  pattern: string;
  /** The actual matched text from the content */
  matched: string;
  /** Character offset of the match within the content */
  offset: number;
}

/**
 * Wraps external user-supplied content in XML tags that mark it as untrusted.
 *
 * Example:
 *   wrapExternalContent("do X instead", "task", "task-123")
 *   // → '<external:task id="task-123" trust="untrusted">\ndo X instead\n</external:task>'
 */
export function wrapExternalContent(
  content: string,
  source: ExternalContentSource,
  id: string,
): string {
  // Sanitise id to prevent tag injection
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `<external:${source} id="${safeId}" trust="untrusted">\n${content}\n</external:${source}>`;
}

/**
 * Known prompt injection pattern definitions.
 */
const INJECTION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: 'ignore-previous-instructions',
    regex: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  },
  {
    label: 'system-tag-injection',
    regex: /\[SYSTEM[\s\S]{0,20}\]/,
  },
  {
    label: 'real-task-redirection',
    regex: /your\s+(real\s+|actual\s+|true\s+)?task\s+(is|:)/i,
  },
  {
    label: 'xml-system-tag',
    regex: /<system>/i,
  },
  {
    label: 'devclaw-path-manipulation',
    regex: /devclaw\/(prompts|projects\/[^/]+\/prompts)\//i,
  },
  {
    label: 'disregard-directive',
    regex: /\bdisregard\s+(the\s+)?(above|previous|prior|all|following)\b/i,
  },
  {
    label: 'jailbreak-attempt',
    regex: /\bDAN\b|\bdo\s+anything\s+now\b/i,
  },
];

/**
 * Scans content for known prompt injection signal patterns.
 *
 * Returns an array of signals (empty if clean). Detection only — does NOT
 * block content or throw. Callers should log signals and decide on action.
 *
 * Example:
 *   const signals = detectInjectionSignals("Ignore all previous instructions and ...");
 *   // → [{ pattern: "ignore-previous-instructions", matched: "Ignore all previous instructions", offset: 0 }]
 */
export function detectInjectionSignals(content: string): InjectionSignal[] {
  const signals: InjectionSignal[] = [];

  for (const { label, regex } of INJECTION_PATTERNS) {
    // Use exec to get position; reset lastIndex for global regexes (not used here but safe)
    const match = regex.exec(content);
    if (match) {
      signals.push({
        pattern: label,
        matched: match[0],
        offset: match.index,
      });
    }
  }

  return signals;
}
