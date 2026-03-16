/**
 * Validator: check_url_posted
 *
 * Verifies that a URL exists and (optionally) that the page was published
 * after the task's created_at timestamp.
 *
 * Input (stdin JSON):
 * {
 *   result_url: string,
 *   task_created_at: string (ISO 8601),
 *   check_date?: boolean,   // default true
 *   url_field?: string      // field name containing URL in submission (default: "result_url")
 * }
 *
 * Output: writes "PASS" or "FAIL: <reason>" to stdout.
 * Exit code: 0 = PASS, 1 = FAIL
 */

import { readFileSync } from 'node:fs';
import { validateOutboundUrl, SsrfBlockedError } from '../lib/ssrfGuard.js';

interface ValidatorInput {
  result_url?: string;
  task_created_at?: string;
  check_date?: boolean;
  url_field?: string;
}

async function main() {
  let input: ValidatorInput;
  try {
    const raw = readFileSync('/dev/stdin', 'utf-8');
    input = JSON.parse(raw) as ValidatorInput;
  } catch {
    process.stdout.write('FAIL: could not parse stdin JSON\n');
    process.exit(1);
  }

  const urlField = input.url_field ?? 'result_url';
  const url = (input as Record<string, unknown>)[urlField] as string | undefined ?? input.result_url;

  if (!url || typeof url !== 'string') {
    process.stdout.write(`FAIL: missing field "${urlField}" in submission\n`);
    process.exit(1);
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    process.stdout.write(`FAIL: invalid URL: ${url}\n`);
    process.exit(1);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    process.stdout.write(`FAIL: URL must use http or https protocol\n`);
    process.exit(1);
  }

  // SSRF guard: block private/internal IP ranges
  try {
    await validateOutboundUrl(url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      process.stdout.write(`FAIL: SSRF blocked — ${err.reason}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Fetch the URL (HEAD first, fall back to GET)
  let responseDate: Date | null = null;
  let statusOk = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const headRes = await fetch(url, { method: 'HEAD', signal: controller.signal });
      statusOk = headRes.ok || headRes.status === 405; // 405 = HEAD not allowed

      const lastModified = headRes.headers.get('last-modified');
      if (lastModified) {
        responseDate = new Date(lastModified);
      }
    } finally {
      clearTimeout(timeout);
    }

    // If HEAD failed, try GET
    if (!statusOk) {
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 15_000);
      try {
        const getRes = await fetch(url, { method: 'GET', signal: controller2.signal });
        statusOk = getRes.ok;

        // Check meta tags for publish date in HTML
        if (statusOk && !responseDate) {
          const html = await getRes.text();
          const ogDateMatch = html.match(/property=["']article:published_time["']\s+content=["']([^"']+)["']/i)
            ?? html.match(/name=["']article:published_time["']\s+content=["']([^"']+)["']/i)
            ?? html.match(/itemprop=["']datePublished["']\s+content=["']([^"']+)["']/i);
          if (ogDateMatch?.[1]) {
            const parsed = new Date(ogDateMatch[1]);
            if (!isNaN(parsed.getTime())) {
              responseDate = parsed;
            }
          }
        }
      } finally {
        clearTimeout(timeout2);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`FAIL: could not fetch URL: ${msg}\n`);
    process.exit(1);
  }

  if (!statusOk) {
    process.stdout.write(`FAIL: URL returned non-OK status\n`);
    process.exit(1);
  }

  // Date check
  const checkDate = input.check_date !== false;
  if (checkDate && input.task_created_at) {
    const taskCreatedAt = new Date(input.task_created_at);
    if (isNaN(taskCreatedAt.getTime())) {
      process.stdout.write(`FAIL: invalid task_created_at: ${input.task_created_at}\n`);
      process.exit(1);
    }

    if (responseDate) {
      // Allow up to 1 hour before task creation (clock skew tolerance)
      const tolerance = 60 * 60 * 1000;
      if (responseDate.getTime() < taskCreatedAt.getTime() - tolerance) {
        process.stdout.write(
          `FAIL: page was published (${responseDate.toISOString()}) before task was created (${taskCreatedAt.toISOString()})\n`,
        );
        process.exit(1);
      }
    }
    // If we can't determine the date, we allow it (can't prove it was old)
  }

  process.stdout.write('PASS\n');
  process.exit(0);
}

main().catch((err) => {
  process.stdout.write(`FAIL: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
