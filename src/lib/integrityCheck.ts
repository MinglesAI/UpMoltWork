/**
 * Prompt File Integrity Check
 *
 * Computes SHA-256 hashes of all files under devclaw/prompts/ and
 * devclaw/projects/*\/prompts/ at startup and re-checks every 5 minutes.
 *
 * If any hash changes between checks, a structured warning is logged with
 * event: "prompt_integrity_violation". This is a DETECTION control —
 * it does not prevent writes, it detects them.
 *
 * Set up alerting on the "prompt_integrity_violation" log event.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the devclaw/prompts directories relative to the project root
// (two levels up from src/lib/)
const PROJECT_ROOT = resolve(__dirname, '../../');
const PROMPT_DIRS = [
  join(PROJECT_ROOT, 'devclaw/prompts'),
];

/** Find all files recursively in a directory, returning absolute paths. */
function listFiles(dir: string): string[] {
  let results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results; // Directory does not exist — skip
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results = results.concat(listFiles(full));
      } else {
        results.push(full);
      }
    } catch {
      // Skip unreadable entries
    }
  }
  return results;
}

/** Also scan devclaw/projects/{project}/prompts/ subdirectories. */
function resolvePromptDirs(): string[] {
  const dirs = [...PROMPT_DIRS];
  const projectsDir = join(PROJECT_ROOT, 'devclaw/projects');
  try {
    const projects = readdirSync(projectsDir);
    for (const project of projects) {
      const promptDir = join(projectsDir, project, 'prompts');
      dirs.push(promptDir);
    }
  } catch {
    // devclaw/projects/ doesn't exist — that's fine
  }
  return dirs;
}

/** Compute SHA-256 hash of a file, returns hex string. */
function hashFile(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '<unreadable>';
  }
}

/** Build a hash map of { filePath → sha256 } for all prompt files. */
function buildHashMap(): Map<string, string> {
  const map = new Map<string, string>();
  const dirs = resolvePromptDirs();
  for (const dir of dirs) {
    const files = listFiles(dir);
    for (const file of files) {
      map.set(file, hashFile(file));
    }
  }
  return map;
}

let baseline: Map<string, string> | null = null;

/** Initialize the integrity check. Call once at startup. */
export function startIntegrityCheck(intervalMs = 5 * 60 * 1000): void {
  baseline = buildHashMap();
  const fileCount = baseline.size;
  console.log(JSON.stringify({
    event: 'prompt_integrity_init',
    fileCount,
    files: Array.from(baseline.keys()),
  }));

  setInterval(() => {
    const current = buildHashMap();

    for (const [file, currentHash] of current) {
      const baselineHash = baseline!.get(file);
      if (baselineHash === undefined) {
        // New file added
        console.warn(JSON.stringify({
          event: 'prompt_integrity_violation',
          violation: 'file_added',
          file,
          hash: currentHash,
        }));
      } else if (baselineHash !== currentHash) {
        // Existing file changed
        console.warn(JSON.stringify({
          event: 'prompt_integrity_violation',
          violation: 'file_modified',
          file,
          expectedHash: baselineHash,
          actualHash: currentHash,
        }));
      }
    }

    for (const [file] of baseline!) {
      if (!current.has(file)) {
        console.warn(JSON.stringify({
          event: 'prompt_integrity_violation',
          violation: 'file_deleted',
          file,
        }));
      }
    }

    // Update baseline so we don't repeatedly alert on the same change
    // (the alert fired once; human must remediate)
    baseline = current;
  }, intervalMs);
}
