/**
 * Validation Runner Service
 *
 * Called on task submission for recurring tasks. Reads validation_type +
 * validation_config from the template (via recurring_task_instances join)
 * and routes to the appropriate validator.
 *
 * Validation types:
 *   auto     → immediately approve
 *   link     → fetch URL, verify post date, update submission status
 *   code     → spawn validator script, parse PASS/FAIL stdout
 *   peer     → existing peer review flow (no change, returns false)
 *   combined → run each step in sequence
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { recurringTaskInstances, recurringTaskTemplates } from '../db/schema/recurringTasks.js';
import { submissions, tasks } from '../db/schema/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VALIDATORS_DIR = resolve(__dirname, '../validators');

export type ValidationResult =
  | { outcome: 'auto_approved' }
  | { outcome: 'peer_review' }       // no-op, use existing peer review
  | { outcome: 'approved' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'error'; reason: string };

/**
 * Run auto-approval — always passes.
 */
async function runAutoValidator(): Promise<ValidationResult> {
  return { outcome: 'auto_approved' };
}

/**
 * Run link validator — checks URL existence and optionally post date.
 */
async function runLinkValidator(
  submissionData: Record<string, unknown>,
  config: Record<string, unknown>,
  taskCreatedAt: Date,
): Promise<ValidationResult> {
  const urlField = (config.url_field as string | undefined) ?? 'result_url';
  const checkDate = config.check_date !== false;

  const url = submissionData[urlField] as string | undefined;
  if (!url) {
    return { outcome: 'rejected', reason: `Missing field "${urlField}" in submission` };
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { outcome: 'rejected', reason: `Invalid URL: ${url}` };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { outcome: 'rejected', reason: 'URL must use http or https protocol' };
  }

  // Fetch the URL
  let statusOk = false;
  let responseDate: Date | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      statusOk = res.ok;

      const lastModified = res.headers.get('last-modified');
      if (lastModified) {
        const d = new Date(lastModified);
        if (!isNaN(d.getTime())) responseDate = d;
      }

      if (statusOk && !responseDate) {
        const html = await res.text();
        const m = html.match(/property=["']article:published_time["']\s+content=["']([^"']+)["']/i)
          ?? html.match(/itemprop=["']datePublished["']\s+content=["']([^"']+)["']/i);
        if (m?.[1]) {
          const d = new Date(m[1]);
          if (!isNaN(d.getTime())) responseDate = d;
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: 'error', reason: `Could not fetch URL: ${msg}` };
  }

  if (!statusOk) {
    return { outcome: 'rejected', reason: 'URL returned non-OK HTTP status' };
  }

  if (checkDate && responseDate) {
    const tolerance = 60 * 60 * 1000; // 1 hour
    if (responseDate.getTime() < taskCreatedAt.getTime() - tolerance) {
      return {
        outcome: 'rejected',
        reason: `Page was published (${responseDate.toISOString()}) before the task was created (${taskCreatedAt.toISOString()})`,
      };
    }
  }

  return { outcome: 'approved' };
}

/**
 * Run a code validator script via child_process.
 * The script receives submission payload as stdin JSON and must write PASS or FAIL: <reason> to stdout.
 */
async function runCodeValidator(
  submissionData: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<ValidationResult> {
  const scriptName = config.script as string | undefined;
  if (!scriptName) {
    return { outcome: 'error', reason: 'code validator missing "script" in validation_config' };
  }

  const timeoutMs = ((config.timeout as number | undefined) ?? 30) * 1000;
  const scriptPath = join(VALIDATORS_DIR, scriptName);

  return new Promise<ValidationResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn('npx', ['tsx', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Write submission data to stdin
    child.stdin.write(JSON.stringify(submissionData));
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        resolvePromise({ outcome: 'error', reason: `Validator script timed out after ${timeoutMs / 1000}s` });
        return;
      }

      const output = stdout.trim();
      if (output.startsWith('PASS')) {
        resolvePromise({ outcome: 'approved' });
      } else if (output.startsWith('FAIL:')) {
        resolvePromise({ outcome: 'rejected', reason: output.slice('FAIL:'.length).trim() });
      } else if (code === 0) {
        resolvePromise({ outcome: 'approved' });
      } else {
        resolvePromise({
          outcome: 'error',
          reason: `Validator script exited with code ${code}. stderr: ${stderr.slice(0, 200)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ outcome: 'error', reason: `Could not spawn validator: ${err.message}` });
    });
  });
}

/**
 * Run combined validator — sequential chain of steps.
 */
async function runCombinedValidator(
  submissionData: Record<string, unknown>,
  config: Record<string, unknown>,
  taskCreatedAt: Date,
): Promise<ValidationResult> {
  const steps = config.steps as string[] | undefined;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { outcome: 'error', reason: 'combined validator missing "steps" array in validation_config' };
  }

  for (const step of steps) {
    let result: ValidationResult;
    switch (step) {
      case 'auto':
        result = await runAutoValidator();
        break;
      case 'link':
        result = await runLinkValidator(submissionData, config, taskCreatedAt);
        break;
      case 'code':
        result = await runCodeValidator(submissionData, config);
        break;
      case 'peer':
        // Peer validation is handled externally; stop the chain here
        return { outcome: 'peer_review' };
      default:
        return { outcome: 'error', reason: `Unknown combined step: "${step}"` };
    }

    if (result.outcome !== 'approved' && result.outcome !== 'auto_approved') {
      return result; // Short-circuit on failure
    }
  }

  return { outcome: 'approved' };
}

/**
 * Main entry point. Called when a task is submitted.
 *
 * @param submissionId - The submission ID
 * @param taskId - The task ID
 * @returns ValidationResult or null if task is not recurring
 */
export async function runValidationForSubmission(
  submissionId: string,
  taskId: string,
): Promise<ValidationResult | null> {
  // Check if this task is from a recurring template
  const instanceRows = await db
    .select({
      templateId: recurringTaskInstances.templateId,
      taskCreatedAt: tasks.createdAt,
    })
    .from(recurringTaskInstances)
    .innerJoin(tasks, eq(tasks.id, recurringTaskInstances.taskId))
    .where(eq(recurringTaskInstances.taskId, taskId))
    .limit(1);

  if (instanceRows.length === 0) {
    return null; // Not a recurring task — use normal flow
  }

  const { templateId, taskCreatedAt } = instanceRows[0];
  if (!templateId) return null;

  // Load template
  const templateRows = await db
    .select({
      validationType: recurringTaskTemplates.validationType,
      validationConfig: recurringTaskTemplates.validationConfig,
    })
    .from(recurringTaskTemplates)
    .where(eq(recurringTaskTemplates.id, templateId))
    .limit(1);

  if (templateRows.length === 0) return null;

  const { validationType, validationConfig } = templateRows[0];
  const config = (validationConfig as Record<string, unknown> | null) ?? {};

  // Load submission data
  const submissionRows = await db
    .select({
      resultUrl: submissions.resultUrl,
      resultContent: submissions.resultContent,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);

  const submissionData: Record<string, unknown> = {
    submission_id: submissionId,
    task_id: taskId,
    task_created_at: taskCreatedAt?.toISOString(),
    result_url: submissionRows[0]?.resultUrl ?? null,
    result_content: submissionRows[0]?.resultContent ?? null,
  };

  switch (validationType) {
    case 'auto':
      return runAutoValidator();
    case 'link':
      return runLinkValidator(submissionData, config, taskCreatedAt ?? new Date());
    case 'code':
      return runCodeValidator(submissionData, config);
    case 'combined':
      return runCombinedValidator(submissionData, config, taskCreatedAt ?? new Date());
    case 'peer':
    default:
      return { outcome: 'peer_review' };
  }
}
