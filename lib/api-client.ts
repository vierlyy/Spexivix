export type ApiError = {
  message: string;
  details?: unknown;
};

export type SearchResult = {
  id: string;
  title: string;
  authors: string[];
  journal: string;
  year: number;
  score: number;
  doi?: string | null;
  sourceUrl?: string | null;
  pdfUrl?: string | null;
  section: string;
  sectionType?: string;
  subsection?: string | null;
  extractionSource?: "full_text" | "abstract";
  extractionNotice?: string;
  highlight: string;
  summary: string;
  explanation?: string;
  simpleExplanation?: string;
  scientificSummary?: string;
  keyFindings?: string[];
  mainConclusion?: string;
  tags: string[];
  highlightedTerms?: string[];
};

export type EvidenceBlock = {
  resultId: string;
  journalId: string;
  chunkId: string;
  title: string;
  authors: string[];
  journal: string;
  year: number;
  doi?: string | null;
  sourceUrl?: string | null;
  pdfUrl?: string | null;
  section: string;
  subsection?: string | null;
  pageNumber?: number | null;
  paragraphNumber?: number | null;
  paragraph: string;
  highlightedSpan: string;
  score: number;
  confidenceLabel: "Direct Evidence" | "Strong Evidence" | "Supporting Evidence";
  citation: string;
  extractionSource: "full_text" | "abstract";
};

export type ResearchAssistant = {
  detectedLanguage: string;
  translatedQuery: string;
  relatedConcepts: string[];
  relatedKeywords: string[];
  suggestedFollowUps: string[];
  relatedTopics: string[];
};

export type SearchResponse = {
  searchId?: string;
  jobId?: string;
  query: string;
  detectedLanguage?: string;
  translatedQuery?: string;
  answer?: string;
  confidenceLabel?: string;
  keyFindings?: string[];
  conclusion?: string;
  citations?: string[];
  sources: string[];
  results: SearchResult[];
  evidence?: EvidenceBlock[];
  assistant?: ResearchAssistant;
  persisted?: boolean;
  cached?: boolean;
  status?: string;
};

export type SearchJobResponse = {
  jobId: string;
  searchId?: string | null;
  status: "queued" | "running" | "completed" | "failed";
  currentStep: string;
  progress: number;
  detectedLanguage?: string;
  translatedQuery?: string | null;
  expandedTerms?: string[];
  error?: string | null;
  result?: SearchResponse | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
};

export type SearchHistoryItem = {
  id?: string;
  query: string;
  detectedLanguage?: string;
  translatedQuery?: string | null;
  resultCount?: number;
  createdAt?: string;
};

export type BookmarkItem = {
  id: string;
  journalId: string;
  collectionId?: string | null;
  note?: string | null;
  citationStyle?: string;
  createdAt?: string;
  title?: string | null;
  doi?: string | null;
  sourceUrl?: string | null;
};

export type CollectionItem = {
  id?: string;
  name: string;
  description?: string | null;
  savedCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as { data?: T; error?: ApiError };

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? "Request failed.");
  }

  if (!payload.data) {
    throw new Error("Missing API response data.");
  }

  return payload.data;
}

export function searchJournals(query: string) {
  return apiRequest<SearchResponse>("/api/search", {
    method: "POST",
    body: JSON.stringify({ query, mode: "sync" }),
  });
}

export function createEvidenceSearch(query: string) {
  return apiRequest<SearchJobResponse>("/api/search", {
    method: "POST",
    body: JSON.stringify({ query, mode: "async" }),
  });
}

export function getEvidenceSearchJob(jobId: string) {
  return apiRequest<SearchJobResponse>(`/api/search/jobs/${jobId}`);
}

export function getSearchHistory() {
  return apiRequest<{ history: SearchHistoryItem[] }>("/api/search/history");
}

export function getBookmarks() {
  return apiRequest<{ bookmarks: BookmarkItem[] }>("/api/bookmarks");
}

export function saveBookmark(journalId: string, collectionId?: string) {
  return apiRequest<{ bookmarkId: string }>("/api/bookmarks", {
    method: "POST",
    body: JSON.stringify({ journalId, collectionId }),
  });
}

export function getCollections() {
  return apiRequest<{ collections: CollectionItem[] }>("/api/collections");
}

export function createCollection(name: string, description?: string) {
  return apiRequest<{ collectionId: string }>("/api/collections", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}
