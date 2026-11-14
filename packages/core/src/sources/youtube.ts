// YouTube comments via the official YouTube Data API v3. Needs YOUTUBE_API_KEY (free, 10,000 units/day).
// Approach adapted from marketgap_scout (MIT, github.com/ad1tyagupta/marketgap_scout): find relevant videos,
// then read their top comments, where viewers describe what they struggle with.
// Quota: one search = 100 units, one commentThreads page = 1 unit, so a query with 6 videos costs ~106 units.
// The key is sent in a header, so it never lands in URLs or the local response cache.
import { fetchJson, HttpError } from "../http.js";
import type { Complaint, SearchOptions, SourceResult, Thread } from "../types.js";

const API = "https://www.googleapis.com/youtube/v3";

export function hasYouTubeKey(): boolean {
  return Boolean(process.env.YOUTUBE_API_KEY);
}

function headers(): Record<string, string> {
  return { "X-Goog-Api-Key": process.env.YOUTUBE_API_KEY ?? "" };
}

interface SearchResponse {
  items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; publishedAt?: string } }[];
}

interface CommentSnippet {
  textOriginal?: string;
  textDisplay?: string;
  authorDisplayName?: string;
  likeCount?: number;
  publishedAt?: string;
}

interface ThreadsResponse {
  items?: {
    id: string;
    snippet?: { videoId?: string; totalReplyCount?: number; topLevelComment?: { id?: string; snippet?: CommentSnippet } };
    replies?: { comments?: { snippet?: CommentSnippet }[] };
  }[];
}

function apiError(e: unknown): string {
  if (e instanceof HttpError) {
    const body = String((e as { body?: unknown }).body ?? e.message);
    if (/quotaExceeded|dailyLimitExceeded/.test(body)) return "YouTube quota exhausted for today (resets at midnight Pacific).";
    if (/API_KEY_INVALID|keyInvalid/.test(body)) return "YOUTUBE_API_KEY is invalid.";
    if (/accessNotConfigured|SERVICE_DISABLED/.test(body)) return "YouTube Data API v3 is not enabled for this key's Google Cloud project.";
    if (/API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|referer/i.test(body))
      return "YOUTUBE_API_KEY has website/IP restrictions that block server use; restrict it to the YouTube Data API only.";
    return `YouTube API error ${e.status}.`;
  }
  return `YouTube API error: ${(e as Error)?.message ?? e}`;
}

function commentText(s: CommentSnippet | undefined): string {
  return (s?.textOriginal ?? s?.textDisplay ?? "").replace(/\s+/g, " ").trim();
}

export async function searchYouTube(
  query: string,
  opts: SearchOptions & { country?: string; videos?: number },
): Promise<SourceResult> {
  if (!hasYouTubeKey()) {
    return {
      source: "youtube",
      query,
      items: [],
      notes: [
        "YouTube skipped: no YOUTUBE_API_KEY. Set it (free, YouTube Data API v3 in Google Cloud) to read comments on relevant videos.",
      ],
    };
  }
  const videos = Math.min(Math.max(opts.videos ?? 6, 1), 15);
  const perVideo = Math.min(Math.max(Math.ceil((opts.limit ?? 30) / videos) * 2, 10), 100);
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(videos),
    relevanceLanguage: opts.lang,
    order: "relevance",
  });
  if (opts.country) params.set("regionCode", opts.country.toUpperCase());
  if (opts.sinceDays) params.set("publishedAfter", new Date(Date.now() - opts.sinceDays * 86400_000).toISOString());

  let search: SearchResponse;
  try {
    search = await fetchJson<SearchResponse>(`${API}/search?${params}`, { headers: headers(), ttl: 24 * 3600 });
  } catch (e) {
    return { source: "youtube", query, items: [], notes: [apiError(e)] };
  }

  const items: Complaint[] = [];
  const notes: string[] = [];
  let skipped = 0;
  let lastErr = "";
  const found = (search.items ?? []).filter((v) => v.id?.videoId);
  for (const v of found) {
    const videoId = v.id!.videoId!;
    const videoTitle = v.snippet?.title ?? "";
    const channel = v.snippet?.channelTitle ?? "";
    const cparams = new URLSearchParams({
      part: "snippet",
      videoId,
      maxResults: String(perVideo),
      order: "relevance",
      textFormat: "plainText",
    });
    try {
      const threads = await fetchJson<ThreadsResponse>(`${API}/commentThreads?${cparams}`, { headers: headers(), ttl: 24 * 3600 });
      for (const t of threads.items ?? []) {
        const top = t.snippet?.topLevelComment;
        const text = commentText(top?.snippet);
        if (!text) continue;
        const commentId = top?.id ?? t.id;
        items.push({
          id: `yt:${videoId}:${commentId}`,
          source: "youtube",
          url: `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`,
          title: `[${channel}] ${videoTitle}`.replace(/^\[\] /, ""),
          text,
          author: top?.snippet?.authorDisplayName,
          createdAt: top?.snippet?.publishedAt,
          engagement: top?.snippet?.likeCount,
          comments: t.snippet?.totalReplyCount,
        });
      }
    } catch (e) {
      skipped++; // comments disabled (403) or similar: skip the video, keep going
      lastErr = apiError(e);
    }
  }
  if (found.length && skipped === found.length) notes.push(`All comment fetches failed: ${lastErr}`);
  else if (skipped) notes.push(`${skipped} video(s) skipped (comments disabled or unavailable).`);
  notes.push(
    `${found.length} video(s) searched, ${items.length} comment(s). Quotes are verbatim from the API; each comment's url opens it on YouTube. Use get_thread with the item id to read its replies.`,
  );
  return { source: "youtube", query, items: items.slice(0, opts.limit ?? 30), notes };
}

/** id tail is "<videoId>:<commentId>". Returns the comment and its replies. */
export async function getYouTubeThread(tail: string, maxReplies = 60): Promise<Thread> {
  if (!hasYouTubeKey()) throw new Error("YouTube needs YOUTUBE_API_KEY.");
  const [videoId, commentId] = tail.split(":");
  if (!videoId || !commentId) throw new Error(`Bad YouTube id "yt:${tail}". Expected yt:<videoId>:<commentId>.`);
  try {
    const t = await fetchJson<ThreadsResponse>(
      `${API}/commentThreads?${new URLSearchParams({ part: "snippet", id: commentId, textFormat: "plainText" })}`,
      { headers: headers(), ttl: 24 * 3600 },
    );
    const top = t.items?.[0]?.snippet?.topLevelComment?.snippet;
    const replies: Thread["replies"] = [];
    let pageToken = "";
    do {
      const p = new URLSearchParams({ part: "snippet", parentId: commentId, maxResults: "100", textFormat: "plainText" });
      if (pageToken) p.set("pageToken", pageToken);
      const r = await fetchJson<{ items?: { snippet?: CommentSnippet }[]; nextPageToken?: string }>(`${API}/comments?${p}`, {
        headers: headers(),
        ttl: 24 * 3600,
      });
      for (const c of r.items ?? [])
        replies.push({
          author: c.snippet?.authorDisplayName,
          text: commentText(c.snippet),
          engagement: c.snippet?.likeCount,
          createdAt: c.snippet?.publishedAt,
        });
      pageToken = r.nextPageToken ?? "";
    } while (pageToken && replies.length < maxReplies);
    return {
      id: `yt:${tail}`,
      source: "youtube",
      url: `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}`,
      text: commentText(top),
      replies: replies.slice(0, maxReplies),
    };
  } catch (e) {
    throw new Error(apiError(e));
  }
}
