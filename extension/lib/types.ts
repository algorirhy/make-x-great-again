export type Label = "spam" | "porn_bot" | "likely_spam" | "uncertain" | "legit";

export interface Verdict {
  label: Label;
  confidence: number;
  reasons: string[];
}

export interface CurationRecord {
  userId: string;
  handle: string;
  verdict: Verdict;
  reviewStatus: string;
  model: string;
}

/** Signals scraped passively from the rendered DOM. */
export interface Signals {
  isProfile: boolean;
  userId?: string;
  handle: string;
  displayName: string;
  bio: string;
  hasDefaultAvatar: boolean;
  avatarUrl?: string;
  recentTweets: string[];
  triggeringComment?: string;
  threadTopic?: string;
  accountAgeDays?: number;
  followersCount?: number;
  followingCount?: number;
  /** The tweet texts above are X machine-translations, not the author's own
   *  words (original unavailable in the DOM). Consumers must not treat the
   *  surface language as an author signal. */
  tweetsTranslated?: boolean;
}

/** Background messages. "list-sync" triggers the public blocklist download
 *  (read-only GET of the official artifact; nothing is uploaded). */
export type BgRequest =
  | { type: "health" }
  | { type: "stats" }
  | { type: "records" }
  | { type: "list-sync"; force?: boolean }
  // GitHub Device Flow (whitelist self-service login). Runs in the
  // background: github.com's device endpoints don't serve CORS, so the
  // fetches need the optional github.com host permission granted first.
  | { type: "gh_start" }
  | { type: "gh_poll"; deviceCode: string }
  // Content script asks the background to open the options page (e.g. a report
  // needs GitHub authorization the user hasn't granted yet).
  | { type: "open_options" }
  // All mutations of the coupled local-hide id set and audit-record list run
  // in the background worker. A single writer prevents concurrent X tabs
  // from losing records through read-modify-write races.
  | { type: "block-records-get" }
  | { type: "block-record-add"; record: import("./store").BlockRecord }
  | {
      type: "block-record-update";
      id: string;
      patch: Partial<Omit<import("./store").BlockRecord, "id">>;
    }
  | { type: "block-record-remove"; id: string }
  // 举报: the authenticated POST to /v1/report MUST run in the background —
  // a content-script fetch is bound by x.com's CORS/CSP, whereas the SW shares
  // the extension origin the whitelist-apply flow already reports from.
  | { type: "report"; sig: Signals };

export interface BgResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}
