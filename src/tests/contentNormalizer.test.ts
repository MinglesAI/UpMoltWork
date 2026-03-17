/**
 * Unit tests for src/middleware/contentNormalizer.ts
 *
 * Tests normalizeText() and validateExternalUrl().
 *
 * Run: npx tsx src/tests/contentNormalizer.test.ts
 */

import { normalizeText, validateExternalUrl } from '../middleware/contentNormalizer.js';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS [${label}]`);
    passed++;
  } else {
    console.error(`  ✗ FAIL [${label}]${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

console.log('\nnormalizeText() tests\n');

// Null byte removal
assert('removes null bytes',
  normalizeText('hello\x00world') === 'helloworld');
assert('removes multiple null bytes',
  normalizeText('\x00\x00test\x00') === 'test');

// Control char removal (non-printable, except \n \r \t)
assert('removes \\x01–\\x08',
  normalizeText('a\x01\x02\x03\x04\x05\x06\x07\x08b') === 'ab');
assert('removes \\x0B (vertical tab)',
  normalizeText('a\x0Bb') === 'ab');
assert('removes \\x0C (form feed)',
  normalizeText('a\x0Cb') === 'ab');
assert('removes \\x0E–\\x1F',
  normalizeText('a\x0E\x1Fb') === 'ab');
assert('removes DEL (\\x7F)',
  normalizeText('a\x7Fb') === 'ab');

// Keep allowed whitespace
assert('keeps \\n',
  normalizeText('hello\nworld') === 'hello\nworld');
assert('keeps \\r',
  normalizeText('hello\rworld') === 'hello\rworld');
assert('keeps \\t',
  normalizeText('hello\tworld') === 'hello\tworld');

// Trim
assert('trims leading/trailing whitespace',
  normalizeText('  hello  ') === 'hello');
assert('trims after removing control chars',
  normalizeText('\x01  hello  \x02') === 'hello');

// Idempotency
assert('idempotent — safe to call twice',
  normalizeText(normalizeText('  hello\x00world\n  ')) === normalizeText('  hello\x00world\n  '));

// Normal text passthrough
assert('passes through normal ASCII text',
  normalizeText('Normal task description.') === 'Normal task description.');
assert('passes through unicode',
  normalizeText('Ciao 🎉 こんにちは') === 'Ciao 🎉 こんにちは');

console.log('\nvalidateExternalUrl() tests\n');

// Dangerous schemes — should be rejected
assert('rejects file:// scheme',
  validateExternalUrl('file:///etc/passwd').ok === false);
assert('rejects javascript: scheme',
  validateExternalUrl('javascript:alert(1)').ok === false);
assert('rejects data: scheme',
  validateExternalUrl('data:text/html,<h1>hi</h1>').ok === false);
assert('rejects FILE:// (case insensitive)',
  validateExternalUrl('FILE:///etc/passwd').ok === false);
assert('rejects JAVASCRIPT: (case insensitive)',
  validateExternalUrl('JAVASCRIPT:void(0)').ok === false);

// Invalid URL
assert('rejects invalid URL',
  validateExternalUrl('not a url').ok === false);
assert('rejects empty string',
  validateExternalUrl('').ok === false);

// Valid URLs — should be accepted
assert('accepts http URL',
  validateExternalUrl('http://example.com/result').ok === true);
assert('accepts https URL',
  validateExternalUrl('https://example.com/result').ok === true);
assert('accepts https URL with path and query',
  validateExternalUrl('https://example.com/path?q=1').ok === true);

// Private IP — accepted but warned (we can't easily test console.warn here)
assert('accepts private IP (warns but does not block)',
  validateExternalUrl('http://192.168.1.1/file').ok === true);
assert('accepts loopback (warns but does not block)',
  validateExternalUrl('http://127.0.0.1/api').ok === true);

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
