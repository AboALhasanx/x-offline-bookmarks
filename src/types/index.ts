export type PendingStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface PendingItem {
  id: number;
  url: string;
  raw_text: string | null;
  shared_at: number;
  status: PendingStatus;
  error_message: string | null;
  updated_at: number;
}

export type BookmarkType = 'article' | 'tweet';

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  type: BookmarkType;
  html_content: string;
  /** Local file URIs for offline images, stored as JSON in SQLite. */
  image_paths: string[];
  /** Offline bundles for links found inside the post. */
  links: TweetLink[];
  /** Full post caption (tweets), used by the copy button. */
  caption: string;
  source_url: string | null;
  saved_at: number;
  viewed: boolean;
}
export interface SharePayload {
  url: string;
  rawText: string | null;
}

export type MediaKind = 'image' | 'video';

export interface TweetMedia {
  kind: MediaKind;
  url: string;
  posterUrl?: string | null;
}

export interface TweetData {
  author: string;
  text: string;
  createdAt: string | null;
  imageUrls: string[];
  /** Direct mp4 URL when the post carries video (og:video). */
  videoUrl: string | null;
  /** Poster image for the video (og:image / video poster), dropped when video saves. */
  posterUrl: string | null;
  /** Ordered collection of all media items (photos and videos). */
  media?: TweetMedia[];
}

export interface TweetLink {
  /** Short URL as seen in the post (often t.co). */
  display: string;
  /** Final destination after following redirects. */
  resolved: string;
  title: string;
  domain: string;
  /** file:// directory holding the offline bundle (index.html + css/ + img/). Empty for quotes. */
  bundleUri: string;
  /** file:// URI of the cleaned reader version (clean.html), if built. */
  cleanUri?: string;
  kind: 'page' | 'quote';
  /** Quoted post text (quotes only). */
  snippet?: string;
  /** Bookmark id of the quoted post (quotes only). */
  tweetBookmarkId?: number;
  /** Set when initial HTML is an empty SPA shell needing background headless preloading */
  needsPreload?: boolean;
}

export interface LocalMediaItem {
  kind: MediaKind;
  local: string;
  poster?: string | null;
}

export interface ThreadPart {
  name: string;
  handle: string;
  text: string;
  images: string[];
  video: string | null;
  media?: LocalMediaItem[];
}
