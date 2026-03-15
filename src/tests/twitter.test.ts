/**
 * Twitter verification tests — unit tests for src/lib/twitter.ts
 *
 * Mocks fetch globally; does NOT require a real Twitter API token or DB.
 *
 * Run:  npx tsx src/tests/twitter.test.ts
 */

import { extractTweetId, verifyTweet } from '../lib/twitter.js';

// ---------------------------------------------------------------------------
// Minimal assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// extractTweetId tests
// ---------------------------------------------------------------------------

console.log('\n=== extractTweetId ===\n');

assert(
  extractTweetId('https://twitter.com/user/status/1234567890123456789') === '1234567890123456789',
  'twitter.com URL',
);
assert(
  extractTweetId('https://x.com/user/status/9876543210') === '9876543210',
  'x.com URL',
);
assert(
  extractTweetId('https://mobile.twitter.com/user/status/111222333') === '111222333',
  'mobile.twitter.com URL',
);
assert(extractTweetId('https://example.com/no-tweet') === null, 'non-tweet URL → null');
assert(extractTweetId('not a url at all') === null, 'garbage string → null');

// ---------------------------------------------------------------------------
// verifyTweet tests — mock fetch
// ---------------------------------------------------------------------------

console.log('\n=== verifyTweet (mocked) ===\n');

// Shared test data
const OWNER_TWITTER = 'testuser';
const CHALLENGE_CODE = 'AXE-abcd-ef01';
const CHALLENGE_CREATED_AT = new Date('2024-01-01T10:00:00Z');
const TWEET_CREATED_AT = '2024-01-01T11:00:00Z'; // 1 hour after challenge

const validTweetText = `Registering on @UpMoltWork ${CHALLENGE_CODE} #UpMoltWork`;

type FetchFn = typeof global.fetch;

function mockFetch(tweetData: unknown, userData: unknown): FetchFn {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/tweets/')) {
      return {
        status: 200,
        json: async () => tweetData,
      } as Response;
    }
    if (url.includes('/users/')) {
      return {
        status: 200,
        json: async () => userData,
      } as Response;
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

function mockFetchStatus(tweetStatus: number): FetchFn {
  return async () => {
    return {
      status: tweetStatus,
      json: async () => ({ errors: [{ type: 'not-found', title: 'Not Found' }] }),
    } as Response;
  };
}

// Ensure TWITTER_API_BEARER_TOKEN is set for real-verification tests
const originalToken = process.env.TWITTER_API_BEARER_TOKEN;
process.env.TWITTER_API_BEARER_TOKEN = 'mock-token-for-tests';

// Helper to run an async assertion
async function assertAsync(fn: () => Promise<boolean>, label: string) {
  try {
    const result = await fn();
    assert(result, label);
  } catch (err) {
    console.error(`  ❌ THREW: ${label} — ${err}`);
    failed++;
  }
}

// --- 1. Happy path ---
const happyTweet = {
  data: { id: '123', text: validTweetText, author_id: 'uid_1', created_at: TWEET_CREATED_AT },
};
const happyUser = { data: { id: 'uid_1', username: OWNER_TWITTER } };

await assertAsync(async () => {
  global.fetch = mockFetch(happyTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return result.verified === true;
}, 'Happy path → verified: true');

// --- 2. Invalid URL ---
await assertAsync(async () => {
  global.fetch = mockFetch(happyTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://example.com/not-a-tweet',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return !result.verified && (result as { reason: string }).reason === 'Invalid tweet URL';
}, 'Invalid tweet URL → Invalid tweet URL');

// --- 3. Tweet not found (404) ---
await assertAsync(async () => {
  global.fetch = mockFetchStatus(404);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { reason: string }).reason === 'Tweet not found. Make sure the tweet is public.'
  );
}, 'Tweet not found (404) → correct error');

// --- 4. Tweet not found (no data) ---
await assertAsync(async () => {
  global.fetch = mockFetch({ errors: [{ type: 'https://api.twitter.com/2/problems/resource-not-found', title: 'Not Found' }] }, {});
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { reason: string }).reason === 'Tweet not found. Make sure the tweet is public.'
  );
}, 'Tweet not found (resource-not-found error type) → correct error');

// --- 5. Wrong author ---
await assertAsync(async () => {
  const wrongUser = { data: { id: 'uid_2', username: 'someone_else' } };
  global.fetch = mockFetch(happyTweet, wrongUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { reason: string }).reason === `Tweet was not posted by @${OWNER_TWITTER}`
  );
}, 'Wrong author → correct error');

// --- 6. Case-insensitive author match ---
await assertAsync(async () => {
  const upperUser = { data: { id: 'uid_1', username: 'TestUser' } };
  global.fetch = mockFetch(happyTweet, upperUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return result.verified === true;
}, 'Author match is case-insensitive → verified: true');

// --- 7. Missing challenge code ---
await assertAsync(async () => {
  const noCodeTweet = {
    data: { id: '123', text: 'Just tweeting #UpMoltWork', author_id: 'uid_1', created_at: TWEET_CREATED_AT },
  };
  global.fetch = mockFetch(noCodeTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { reason: string }).reason === `Tweet must contain the challenge code: ${CHALLENGE_CODE}`
  );
}, 'Missing challenge code → correct error');

// --- 8. Missing #UpMoltWork ---
await assertAsync(async () => {
  const noHashTweet = {
    data: { id: '123', text: `Hello ${CHALLENGE_CODE}`, author_id: 'uid_1', created_at: TWEET_CREATED_AT },
  };
  global.fetch = mockFetch(noHashTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { reason: string }).reason === 'Tweet must contain #UpMoltWork'
  );
}, 'Missing #UpMoltWork → correct error');

// --- 9. #upmoltwork case-insensitive ---
await assertAsync(async () => {
  const lowerHashTweet = {
    data: { id: '123', text: `${CHALLENGE_CODE} #upmoltwork`, author_id: 'uid_1', created_at: TWEET_CREATED_AT },
  };
  global.fetch = mockFetch(lowerHashTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return result.verified === true;
}, '#upmoltwork lowercase → verified: true (case-insensitive)');

// --- 10. Tweet too old ---
await assertAsync(async () => {
  const oldTweet = {
    data: {
      id: '123',
      text: validTweetText,
      author_id: 'uid_1',
      created_at: '2023-12-31T09:00:00Z', // before challenge created_at
    },
  };
  global.fetch = mockFetch(oldTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { reason: string }).reason ===
      'Tweet is older than the challenge expiry. Re-initiate verification.'
  );
}, 'Tweet older than challenge → correct error');

// --- 11. Tweet posted after 24h window ---
await assertAsync(async () => {
  const lateTweet = {
    data: {
      id: '123',
      text: validTweetText,
      author_id: 'uid_1',
      created_at: '2024-01-02T11:00:01Z', // 25h after challenge created_at (2024-01-01T10:00:00Z)
    },
  };
  global.fetch = mockFetch(lateTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { reason: string }).reason ===
      'Tweet is older than the challenge expiry. Re-initiate verification.'
  );
}, 'Tweet posted 25h after challenge → correct error (24h window enforced)');

// --- 13. 429 rate limit ---
await assertAsync(async () => {
  global.fetch = mockFetchStatus(429);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { status?: number }).status === 429
  );
}, '429 rate limit → status 429');

// --- 12. 401 invalid token ---
await assertAsync(async () => {
  global.fetch = mockFetchStatus(401);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return (
    !result.verified &&
    (result as { status?: number }).status === 503
  );
}, '401 invalid token → 503 service unavailable');

// --- 14. Stub mode (no token) ---
await assertAsync(async () => {
  delete process.env.TWITTER_API_BEARER_TOKEN;
  const result = await verifyTweet({
    tweetUrl: 'https://example.com/not-even-a-tweet',
    ownerTwitter: OWNER_TWITTER,
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return result.verified === true;
}, 'Stub mode (no bearer token) → always verified: true');

// --- 15. ownerTwitter with @ prefix ---
await assertAsync(async () => {
  process.env.TWITTER_API_BEARER_TOKEN = 'mock-token-for-tests';
  global.fetch = mockFetch(happyTweet, happyUser);
  const result = await verifyTweet({
    tweetUrl: 'https://twitter.com/testuser/status/123',
    ownerTwitter: '@testuser', // with @ prefix
    challengeCode: CHALLENGE_CODE,
    challengeCreatedAt: CHALLENGE_CREATED_AT,
  });
  return result.verified === true;
}, 'ownerTwitter with @ prefix stripped correctly → verified: true');

// Restore original token
if (originalToken !== undefined) {
  process.env.TWITTER_API_BEARER_TOKEN = originalToken;
} else {
  delete process.env.TWITTER_API_BEARER_TOKEN;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed ✅');
}
