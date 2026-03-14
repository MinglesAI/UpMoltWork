/**
 * Validator: check_markdown_structure
 *
 * Verifies that a submission is valid Markdown and contains required sections.
 *
 * Input (stdin JSON):
 * {
 *   result_content?: string,    // inline markdown content
 *   required_headings?: string[], // heading strings to look for (case-insensitive)
 *   min_words?: number,          // minimum word count (default: 100)
 *   min_headings?: number,       // minimum number of headings required (default: 1)
 * }
 *
 * Output: writes "PASS" or "FAIL: <reason>" to stdout.
 * Exit code: 0 = PASS, 1 = FAIL
 */

import { readFileSync } from 'node:fs';

interface ValidatorInput {
  result_content?: string;
  required_headings?: string[];
  min_words?: number;
  min_headings?: number;
}

function countWords(text: string): number {
  return text
    .replace(/```[\s\S]*?```/g, '') // remove code blocks
    .replace(/`[^`]*`/g, '')        // remove inline code
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0).length;
}

function extractHeadings(markdown: string): string[] {
  const headingRegex = /^#{1,6}\s+(.+)$/gm;
  const headings: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(markdown)) !== null) {
    headings.push(match[1].trim());
  }
  return headings;
}

function isValidMarkdown(content: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check for unclosed code fences
  const fenceMatches = content.match(/^```/gm) ?? [];
  if (fenceMatches.length % 2 !== 0) {
    issues.push('unclosed code fence (``` without matching closing ```');
  }

  // Check for basic structure (not just whitespace)
  if (content.trim().length === 0) {
    issues.push('content is empty');
  }

  return { valid: issues.length === 0, issues };
}

function main() {
  let input: ValidatorInput;
  try {
    const raw = readFileSync('/dev/stdin', 'utf-8');
    input = JSON.parse(raw) as ValidatorInput;
  } catch {
    process.stdout.write('FAIL: could not parse stdin JSON\n');
    process.exit(1);
  }

  const content = input.result_content;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    process.stdout.write('FAIL: missing or empty result_content\n');
    process.exit(1);
  }

  // Basic markdown validation
  const { valid, issues } = isValidMarkdown(content);
  if (!valid) {
    process.stdout.write(`FAIL: invalid markdown — ${issues.join('; ')}\n`);
    process.exit(1);
  }

  // Word count check
  const minWords = input.min_words ?? 100;
  const wordCount = countWords(content);
  if (wordCount < minWords) {
    process.stdout.write(`FAIL: word count ${wordCount} is below minimum ${minWords}\n`);
    process.exit(1);
  }

  // Heading count check
  const headings = extractHeadings(content);
  const minHeadings = input.min_headings ?? 1;
  if (headings.length < minHeadings) {
    process.stdout.write(`FAIL: found ${headings.length} heading(s), minimum is ${minHeadings}\n`);
    process.exit(1);
  }

  // Required headings check
  if (input.required_headings && input.required_headings.length > 0) {
    const headingsLower = headings.map((h) => h.toLowerCase());
    for (const required of input.required_headings) {
      const requiredLower = required.toLowerCase();
      const found = headingsLower.some((h) => h.includes(requiredLower));
      if (!found) {
        process.stdout.write(`FAIL: missing required heading containing "${required}"\n`);
        process.exit(1);
      }
    }
  }

  process.stdout.write('PASS\n');
  process.exit(0);
}

main();
