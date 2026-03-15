/**
 * Twitter/X API v2 client for tweet verification.
 *
 * Verifies that a tweet:
 *   1. Exists and is public
 *   2. Was authored by the expected Twitter user
 *   3. Contains the challenge code
 *   4. Contains #UpMoltWork
 *   5. Was created after the challenge was issued (within 24h window)
 */

const TWITTER_API_BASE = 'https://api.twitter.com/2';

export interface VerifyTweetOptions {
  tweetUrl: string;
  ownerTwitter: string;
  challengeCode: string;
  challengeCreatedAt: Date;
}

export type VerifyTweetResult =
  | { verified: true }
  | { verified: false; reason: string; status?: number };

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Extract tweet ID from URL formats:
 *   https://twitter.com/user/status/1234567890
 *   https://x.com/user/status/1234567890
 *   https://mobile.twitter.com/user/status/1234567890
 */
export function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Twitter API v2 calls
// ---------------------------------------------------------------------------

interface TweetData {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
}

interface TweetResponse {
  data?: TweetData;
  errors?: Array<{ type: string; title: string; detail?: string }>;
}

interface UserData {
  id: string;
  username: string;
}

interface UserResponse {
  data?: UserData;
  errors?: Array<{ type: string; title: string; detail?: string }>;
}

async function fetchTweet(
  tweetId: string,
  bearerToken: string,
): Promise<{ data?: TweetData; errors?: TweetResponse['errors']; httpStatus: number }> {
  const url = `${TWITTER_API_BASE}/tweets/${tweetId}?tweet.fields=author_id,text,created_at`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (res.status === 429) {
    return { httpStatus: 429 };
  }
  if (res.status === 401) {
    return { httpStatus: 401 };
  }

  const json = (await res.json()) as TweetResponse;
  return { data: json.data, errors: json.errors, httpStatus: res.status };
}

async function fetchUser(
  userId: string,
  bearerToken: string,
): Promise<{ data?: UserData; httpStatus: number }> {
  const url = `${TWITTER_API_BASE}/users/${userId}?user.fields=username`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  const json = (await res.json()) as UserResponse;
  return { data: json.data, httpStatus: res.status };
}

// ---------------------------------------------------------------------------
// Main verifyTweet function
// ---------------------------------------------------------------------------

/**
 * Full Twitter/X verification pipeline.
 *
 * If TWITTER_API_BEARER_TOKEN is not set, falls back to stub mode
 * (always returns verified: true) and logs a warning.
 */
export async function verifyTweet(opts: VerifyTweetOptions): Promise<VerifyTweetResult> {
  const { tweetUrl, ownerTwitter, challengeCode, challengeCreatedAt } = opts;

  const bearerToken = process.env.TWITTER_API_BEARER_TOKEN;

  // --- Dev / stub mode ---
  if (!bearerToken) {
    console.warn(
      '[twitter] TWITTER_API_BEARER_TOKEN not set — skipping real verification (stub mode)',
    );
    return { verified: true };
  }

  // Step 1: Extract Tweet ID
  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    return { verified: false, reason: 'Invalid tweet URL', status: 400 };
  }

  // Step 2: Look up tweet
  let tweetResult: Awaited<ReturnType<typeof fetchTweet>>;
  try {
    tweetResult = await fetchTweet(tweetId, bearerToken);
  } catch {
    return {
      verified: false,
      reason: 'Twitter verification service unavailable. Try again.',
      status: 503,
    };
  }

  if (tweetResult.httpStatus === 429) {
    return {
      verified: false,
      reason: 'Twitter verification service unavailable. Try again.',
      status: 429,
    };
  }

  if (tweetResult.httpStatus === 401) {
    console.error('[twitter] Bearer token is invalid (401)');
    return {
      verified: false,
      reason: 'Twitter verification service unavailable. Try again.',
      status: 503,
    };
  }

  const isNotFound =
    tweetResult.httpStatus === 404 ||
    !tweetResult.data ||
    tweetResult.errors?.some(
      (e) => e.type === 'https://api.twitter.com/2/problems/resource-not-found',
    );

  if (isNotFound) {
    return {
      verified: false,
      reason: 'Tweet not found. Make sure the tweet is public.',
      status: 400,
    };
  }

  const tweet = tweetResult.data!;

  // Step 3: Look up author username
  let userResult: Awaited<ReturnType<typeof fetchUser>>;
  try {
    userResult = await fetchUser(tweet.author_id, bearerToken);
  } catch {
    return {
      verified: false,
      reason: 'Twitter verification service unavailable. Try again.',
      status: 503,
    };
  }

  if (!userResult.data) {
    return {
      verified: false,
      reason: 'Twitter verification service unavailable. Try again.',
      status: 503,
    };
  }

  // Step 4: Validate all conditions

  // 4a: Author matches
  if (userResult.data.username.toLowerCase() !== ownerTwitter.replace(/^@/, '').toLowerCase()) {
    return {
      verified: false,
      reason: `Tweet was not posted by @${ownerTwitter.replace(/^@/, '')}`,
      status: 400,
    };
  }

  // 4b: Challenge code in text
  if (!tweet.text.includes(challengeCode)) {
    return {
      verified: false,
      reason: `Tweet must contain the challenge code: ${challengeCode}`,
      status: 400,
    };
  }

  // 4c: #UpMoltWork in text (case-insensitive)
  if (!tweet.text.toLowerCase().includes('#upmoltwork')) {
    return {
      verified: false,
      reason: 'Tweet must contain #UpMoltWork',
      status: 400,
    };
  }

  // 4d: Tweet must be within the 24h challenge window
  // - Not before challenge was created
  // - Not more than 24h after challenge was created
  const tweetCreatedAt = new Date(tweet.created_at);
  const expiryTime = new Date(challengeCreatedAt.getTime() + 24 * 60 * 60 * 1000);
  if (tweetCreatedAt < challengeCreatedAt || tweetCreatedAt > expiryTime) {
    return {
      verified: false,
      reason: 'Tweet is older than the challenge expiry. Re-initiate verification.',
      status: 400,
    };
  }

  return { verified: true };
}
