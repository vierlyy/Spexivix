import { XMLParser } from "fast-xml-parser";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { journals, journalSections, searches, searchResults } from "@/db/schema";

const NCBI_BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const CROSSREF_BASE_URL = "https://api.crossref.org/works";
const DEFAULT_RESULT_LIMIT = 8;
const PMC_FETCH_LIMIT = 10;
const PUBMED_FETCH_LIMIT = 18;
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24;

type ExtractionSource = "full_text" | "abstract";

type PaperSection = {
  heading: string;
  sectionType: string;
  source: ExtractionSource;
  text: string;
};

type ScientificPaper = {
  id: string;
  title: string;
  authors: string[];
  year: number;
  doi: string | null;
  journal: string;
  sourceUrl: string;
  pdfUrl: string | null;
  abstractSections: PaperSection[];
  fullTextSections: PaperSection[];
  metadata: Record<string, unknown>;
};

type ScientificQueryContext = {
  originalQuery: string;
  detectedLanguage: string;
  translatedQuery: string;
  normalizedQuery: string;
  searchQueries: string[];
  expandedTerms: string[];
};

type SummaryBundle = {
  simpleExplanation: string;
  scientificSummary: string;
  keyFindings: string[];
  mainConclusion: string;
};

type RankedChunk = {
  paper: ScientificPaper;
  sectionHeading: string;
  sectionType: string;
  extractionSource: ExtractionSource;
  extractionNotice: string;
  content: string;
  score: number;
  explanation: string;
  summary: string;
  tags: string[];
  highlightedTerms: string[];
} & SummaryBundle;

export type ResearchAssistant = {
  detectedLanguage: string;
  translatedQuery: string;
  relatedConcepts: string[];
  relatedKeywords: string[];
  suggestedFollowUps: string[];
  relatedTopics: string[];
};

export type JournalSearchResult = {
  id: string;
  title: string;
  authors: string[];
  journal: string;
  year: number;
  score: number;
  doi: string | null;
  sourceUrl: string | null;
  pdfUrl: string | null;
  section: string;
  sectionType: string;
  extractionSource: ExtractionSource;
  extractionNotice: string;
  highlight: string;
  summary: string;
  explanation: string;
  simpleExplanation: string;
  scientificSummary: string;
  keyFindings: string[];
  mainConclusion: string;
  tags: string[];
  highlightedTerms: string[];
};

export type JournalSearchResponse = {
  searchId: string;
  query: string;
  detectedLanguage: string;
  translatedQuery: string;
  sources: string[];
  results: JournalSearchResult[];
  assistant: ResearchAssistant;
  persisted: boolean;
  cached: boolean;
};

const semanticExpansions: Record<string, string[]> = {
  nox: ["nadph", "oxidase", "nox2", "nox4", "ros", "reactive", "oxygen", "oxidative", "stress"],
  nox2: ["nox", "nadph", "oxidase", "ros", "phagocyte", "macrophage"],
  nox4: ["nox", "nadph", "oxidase", "ros", "fibrosis", "epithelial"],
  nadph: ["nox", "oxidase", "ros", "oxidative", "reactive", "oxygen"],
  oxidase: ["nox", "nadph", "ros", "oxidative"],
  ros: ["reactive", "oxygen", "species", "oxidative", "stress", "nox", "nadph"],
  oxidative: ["stress", "ros", "reactive", "oxygen", "nox", "antioxidant"],
  stress: ["oxidative", "ros", "inflammation", "injury"],
  lung: ["pulmonary", "airway", "alveolar", "respiratory"],
  lungs: ["pulmonary", "airway", "alveolar", "respiratory"],
  pulmonary: ["lung", "airway", "alveolar", "respiratory"],
  airway: ["lung", "pulmonary", "bronchial", "respiratory"],
  alveolar: ["lung", "pulmonary", "macrophage", "epithelial"],
  inflammation: ["inflammatory", "cytokine", "macrophage", "neutrophil", "il-6", "immune"],
  inflammatory: ["inflammation", "cytokine", "macrophage", "neutrophil", "il-6", "immune"],
  macrophage: ["macrophages", "alveolar", "immune", "inflammation", "phagocyte"],
  macrophages: ["macrophage", "alveolar", "immune", "inflammation", "phagocyte"],
  cytokine: ["cytokines", "il-6", "tnf", "inflammation", "inflammatory"],
  cytokines: ["cytokine", "il-6", "tnf", "inflammation", "inflammatory"],
};

const multilingualGlossary: Array<[RegExp, string]> = [
  [/\bperan\b/gi, "role"],
  [/\bdalam\b/gi, "in"],
  [/\binflamasi\b/gi, "inflammation"],
  [/\bparu[-\s]?paru\b/gi, "lung"],
  [/\bparu\b/gi, "lung"],
  [/\bpenyakit\b/gi, "disease"],
  [/\bsel\b/gi, "cell"],
  [/\bmakrofag\b/gi, "macrophage"],
  [/\bstres oksidatif\b/gi, "oxidative stress"],
  [/\bspesies oksigen reaktif\b/gi, "reactive oxygen species"],
  [/\bperanan\b/gi, "role"],
  [/\bpapel\b/gi, "role"],
  [/\binflamaci[oó]n\b/gi, "inflammation"],
  [/\bpulm[oó]n\b/gi, "lung"],
  [/\bpulmonar\b/gi, "pulmonary"],
  [/\br[oô]le\b/gi, "role"],
  [/\binflammation\b/gi, "inflammation"],
  [/\bpoumon\b/gi, "lung"],
  [/\bentz[uü]ndung\b/gi, "inflammation"],
  [/\blunge\b/gi, "lung"],
  [/\bpapel\b/gi, "role"],
  [/\binflama[cç][aã]o\b/gi, "inflammation"],
  [/\bpulm[aã]o\b/gi, "lung"],
];

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "role",
  "that",
  "the",
  "their",
  "this",
  "to",
  "with",
]);

const xmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
});

export async function runJournalSearch({
  query,
  sources,
  userId,
}: {
  query: string;
  sources?: string[];
  userId: string;
}): Promise<JournalSearchResponse> {
  const context = await prepareScientificQuery(query);
  const cached = await getCachedSearch(query, userId, context);
  if (cached) {
    return cached;
  }

  const [fullTextPapers, abstractPapers] = await Promise.all([
    searchPubMedCentral(context),
    searchPubMedAbstracts(context),
  ]);
  const papers = mergePapers(fullTextPapers, abstractPapers);
  const rankedChunks = await rankChunks(context, papers);
  const selectedChunks = selectBestChunkPerPaper(rankedChunks).slice(0, DEFAULT_RESULT_LIMIT);
  const assistant = buildResearchAssistant(context, selectedChunks);
  const searchId = crypto.randomUUID();
  const selectedSources = sources?.length ? sources : deriveSources(selectedChunks, fullTextPapers.length);

  const results = await persistSearchResults({
    assistant,
    context,
    rankedChunks: selectedChunks,
    searchId,
    selectedSources,
    userId,
  });

  return {
    searchId,
    query,
    detectedLanguage: context.detectedLanguage,
    translatedQuery: context.translatedQuery,
    sources: selectedSources,
    results,
    assistant,
    persisted: true,
    cached: false,
  };
}

async function getCachedSearch(
  query: string,
  userId: string,
  context: ScientificQueryContext,
): Promise<JournalSearchResponse | null> {
  const [existingSearch] = await db
    .select()
    .from(searches)
    .where(and(eq(searches.userId, userId), eq(searches.query, query)))
    .orderBy(desc(searches.createdAt))
    .limit(1);

  if (!existingSearch) {
    return null;
  }

  if (Date.now() - existingSearch.createdAt.getTime() > CACHE_MAX_AGE_MS) {
    return null;
  }

  const rows = await db
    .select({
      journalId: journals.id,
      title: journals.title,
      authors: journals.authors,
      journal: journals.journalName,
      year: journals.publicationYear,
      doi: journals.doi,
      sourceUrl: journals.sourceUrl,
      pdfUrl: journals.pdfUrl,
      section: journalSections.heading,
      sectionType: journalSections.sectionType,
      sectionExtractionSource: journalSections.extractionSource,
      highlight: searchResults.highlightedText,
      summary: searchResults.aiSummary,
      simpleExplanation: searchResults.simpleExplanation,
      scientificSummary: searchResults.scientificSummary,
      keyFindings: searchResults.keyFindings,
      mainConclusion: searchResults.mainConclusion,
      extractionSource: searchResults.extractionSource,
      tags: journalSections.tags,
      score: searchResults.relevanceScore,
      rank: searchResults.rank,
    })
    .from(searchResults)
    .innerJoin(journals, eq(searchResults.journalId, journals.id))
    .leftJoin(journalSections, eq(searchResults.sectionId, journalSections.id))
    .where(eq(searchResults.searchId, existingSearch.id))
    .orderBy(searchResults.rank);

  if (!rows.length && existingSearch.resultCount > 0) {
    return null;
  }

  const seenJournals = new Set<string>();
  const results = rows
    .filter((row) => {
      if (seenJournals.has(row.journalId)) {
        return false;
      }

      seenJournals.add(row.journalId);
      return true;
    })
    .map((row) => {
      const extractionSource = (row.extractionSource || row.sectionExtractionSource || "abstract") as ExtractionSource;
      return {
        id: row.journalId,
        title: row.title,
        authors: row.authors,
        journal: row.journal,
        year: row.year,
        score: Math.round(row.score),
        doi: row.doi,
        sourceUrl: row.sourceUrl,
        pdfUrl: row.pdfUrl,
        section: row.section ?? (extractionSource === "full_text" ? "Full text section" : "Relevant abstract section"),
        sectionType: row.sectionType ?? extractionSource,
        extractionSource,
        extractionNotice: getExtractionNotice(extractionSource),
        highlight: row.highlight,
        summary: row.summary,
        explanation: row.simpleExplanation || row.summary,
        simpleExplanation: row.simpleExplanation || row.summary,
        scientificSummary: row.scientificSummary || row.summary,
        keyFindings: row.keyFindings ?? [],
        mainConclusion: row.mainConclusion || row.summary,
        tags: row.tags ?? [],
        highlightedTerms: getHighlightedTerms(context, row.highlight),
      };
    });

  const assistant = normalizeAssistantMetadata(existingSearch.assistantMetadata, context, results);

  return {
    searchId: existingSearch.id,
    query: existingSearch.query,
    detectedLanguage: existingSearch.detectedLanguage ?? context.detectedLanguage,
    translatedQuery: existingSearch.translatedQuery ?? context.translatedQuery,
    sources: Array.from(new Set(results.map((result) => result.extractionNotice).filter(Boolean))),
    results,
    assistant,
    persisted: true,
    cached: true,
  };
}

async function prepareScientificQuery(originalQuery: string): Promise<ScientificQueryContext> {
  const local = translateLocally(originalQuery);
  const ai = await translateWithOpenAI(originalQuery);
  const detectedLanguage = ai?.detectedLanguage || local.detectedLanguage;
  const translatedQuery = cleanText(ai?.translatedQuery || local.translatedQuery || originalQuery);
  const normalizedQuery = normalizeScientificQuery(`${translatedQuery} ${originalQuery}`);
  const expandedTerms = [...expandTerms(tokenize(normalizedQuery))].slice(0, 28);
  const searchQueries = uniqueStrings([
    originalQuery,
    translatedQuery,
    normalizeScientificQuery(translatedQuery),
    buildScientificFallbackQuery(normalizedQuery),
  ]).filter((term) => term.length > 2);

  return {
    originalQuery,
    detectedLanguage,
    translatedQuery,
    normalizedQuery,
    searchQueries,
    expandedTerms,
  };
}

async function translateWithOpenAI(query: string): Promise<{ detectedLanguage: string; translatedQuery: string } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Detect the language of a scientific literature search query and translate the scientific intent into concise English. Return JSON only.",
          },
          {
            role: "user",
            content: `Query: ${query}\nReturn {"detectedLanguage":"...","translatedQuery":"..."}. Preserve gene/protein names, abbreviations, and biomedical terms.`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as { detectedLanguage?: string; translatedQuery?: string };
    if (!parsed.translatedQuery) {
      return null;
    }

    return {
      detectedLanguage: parsed.detectedLanguage || "unknown",
      translatedQuery: parsed.translatedQuery,
    };
  } catch {
    return null;
  }
}

function translateLocally(query: string) {
  let translatedQuery = query;
  for (const [pattern, replacement] of multilingualGlossary) {
    translatedQuery = translatedQuery.replace(pattern, replacement);
  }

  return {
    detectedLanguage: detectLanguage(query),
    translatedQuery: normalizeScientificQuery(translatedQuery),
  };
}

function detectLanguage(query: string) {
  const lower = query.toLowerCase();
  if (/\b(peran|dalam|inflamasi|paru|makrofag|penyakit)\b/.test(lower)) {
    return "Indonesian";
  }
  if (/\b(papel|inflamación|pulmón|pulmonar)\b/.test(lower)) {
    return "Spanish";
  }
  if (/\b(rôle|poumon|inflammation)\b/.test(lower) && /[àâçéèêëîïôûùüÿñæœ]/i.test(query)) {
    return "French";
  }
  if (/\b(entzündung|lunge)\b/.test(lower)) {
    return "German";
  }
  if (/[^\u0000-\u007f]/.test(query)) {
    return "non-English";
  }

  return "English";
}

async function searchPubMedCentral(context: ScientificQueryContext): Promise<ScientificPaper[]> {
  const ids = await fetchIdsForQueries("pmc", context, PMC_FETCH_LIMIT);
  if (!ids.length) {
    return [];
  }

  return fetchPmcArticles(ids);
}

async function searchPubMedAbstracts(context: ScientificQueryContext): Promise<ScientificPaper[]> {
  const ids = await fetchIdsForQueries("pubmed", context, PUBMED_FETCH_LIMIT);
  if (!ids.length) {
    return [];
  }

  const papers = await fetchPubMedArticles(ids);
  return Promise.all(papers.map(enrichWithCrossref));
}

async function fetchIdsForQueries(dbName: "pmc" | "pubmed", context: ScientificQueryContext, limit: number) {
  const terms = uniqueStrings([
    ...context.searchQueries,
    expandPubMedQuery(context),
  ]);
  const perQueryLimit = Math.max(6, Math.ceil(limit / terms.length) + 4);
  const idSets = await Promise.all(terms.map((term) => fetchNcbiIds(dbName, term, perQueryLimit)));

  return uniqueStrings(idSets.flat()).slice(0, limit);
}

async function fetchNcbiIds(dbName: "pmc" | "pubmed", term: string, retmax: number): Promise<string[]> {
  const params = new URLSearchParams({
    db: dbName,
    retmode: "json",
    retmax: String(retmax),
    sort: "relevance",
    term,
  });
  const response = await fetch(`${NCBI_BASE_URL}/esearch.fcgi?${params}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Spexivix/0.2 (AI scientific research platform)",
    },
    next: { revalidate: 60 * 60 },
  });

  if (!response.ok) {
    throw new Error(`${dbName === "pmc" ? "PubMed Central" : "PubMed"} search request failed.`);
  }

  const payload = (await response.json()) as { esearchresult?: { idlist?: string[] } };
  return payload.esearchresult?.idlist ?? [];
}

async function fetchPmcArticles(ids: string[]): Promise<ScientificPaper[]> {
  const params = new URLSearchParams({
    db: "pmc",
    id: ids.join(","),
    retmode: "xml",
  });
  const response = await fetch(`${NCBI_BASE_URL}/efetch.fcgi?${params}`, {
    headers: {
      Accept: "application/xml",
      "User-Agent": "Spexivix/0.2 (AI scientific research platform)",
    },
    next: { revalidate: 60 * 60 },
  });

  if (!response.ok) {
    throw new Error("PubMed Central full-text fetch failed.");
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const root = (parsed["pmc-articleset"] ?? parsed.PmcArticleset ?? parsed) as Record<string, unknown>;
  const articles = toArray(root.article);

  return articles.map(parsePmcArticle).filter(Boolean) as ScientificPaper[];
}

async function fetchPubMedArticles(ids: string[]): Promise<ScientificPaper[]> {
  const params = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "xml",
  });
  const response = await fetch(`${NCBI_BASE_URL}/efetch.fcgi?${params}`, {
    headers: {
      Accept: "application/xml",
      "User-Agent": "Spexivix/0.2 (AI scientific research platform)",
    },
    next: { revalidate: 60 * 60 },
  });

  if (!response.ok) {
    throw new Error("PubMed article fetch failed.");
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml) as {
    PubmedArticleSet?: { PubmedArticle?: unknown[] | unknown };
  };
  const articles = toArray(parsed.PubmedArticleSet?.PubmedArticle);
  return articles.map(parsePubMedArticle).filter(Boolean) as ScientificPaper[];
}

function parsePmcArticle(article: unknown): ScientificPaper | null {
  const value = article as Record<string, unknown>;
  const front = value.front as Record<string, unknown> | undefined;
  const articleMeta = front?.["article-meta"] as Record<string, unknown> | undefined;
  const journalMeta = front?.["journal-meta"] as Record<string, unknown> | undefined;
  const body = value.body as Record<string, unknown> | undefined;
  const pmcid = normalizePmcId(getArticleId(articleMeta?.["article-id"], "pmc"));
  const pmid = getArticleId(articleMeta?.["article-id"], "pmid");
  const doi = getArticleId(articleMeta?.["article-id"], "doi");
  const title = cleanText(getPlainText((articleMeta?.["title-group"] as Record<string, unknown> | undefined)?.["article-title"]));
  const journal = cleanText(
    getPlainText((journalMeta?.["journal-title-group"] as Record<string, unknown> | undefined)?.["journal-title"]) ||
      getPlainText(journalMeta?.["journal-title"]) ||
      "PubMed Central",
  );
  const fullTextSections = parsePmcBodySections(body);
  const abstractSections = parsePmcAbstract(articleMeta?.abstract);

  if (!title || (!pmcid && !doi) || !fullTextSections.length) {
    return null;
  }

  const sourceUrl = pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` : `https://doi.org/${doi}`;

  return {
    id: pmcid || pmid || doi || title,
    title,
    authors: parsePmcAuthors(articleMeta?.["contrib-group"]),
    year: parsePmcYear(articleMeta?.["pub-date"]),
    doi,
    journal,
    sourceUrl,
    pdfUrl: pmcid ? `${sourceUrl}pdf/` : null,
    abstractSections,
    fullTextSections,
    metadata: {
      doi,
      pmcid,
      pubmedId: pmid,
      source: "PubMed Central",
      fullTextAvailable: true,
    },
  };
}

function parsePubMedArticle(article: unknown): ScientificPaper | null {
  const value = article as Record<string, unknown>;
  const medline = value.MedlineCitation as Record<string, unknown> | undefined;
  const pubmedData = value.PubmedData as Record<string, unknown> | undefined;
  const articleData = medline?.Article as Record<string, unknown> | undefined;
  const journalData = articleData?.Journal as Record<string, unknown> | undefined;
  const pmid = getTextValue(medline?.PMID);
  const title = cleanText(String(articleData?.ArticleTitle ?? ""));
  const abstractSections = parsePubMedAbstract(articleData?.Abstract);

  if (!pmid || !title || !abstractSections.length) {
    return null;
  }

  const doi = getArticleId(pubmedData?.ArticleIdList, "doi");
  const journal = cleanText(String(journalData?.Title ?? journalData?.ISOAbbreviation ?? "PubMed"));
  const sourceUrl = doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

  return {
    id: pmid,
    title,
    authors: parsePubMedAuthors(articleData?.AuthorList),
    year: parsePubMedYear(journalData?.JournalIssue),
    doi,
    journal,
    sourceUrl,
    pdfUrl: null,
    abstractSections,
    fullTextSections: [],
    metadata: {
      pubmedId: pmid,
      source: "PubMed",
      fullTextAvailable: false,
    },
  };
}

async function enrichWithCrossref(paper: ScientificPaper): Promise<ScientificPaper> {
  try {
    const params = paper.doi
      ? null
      : new URLSearchParams({
          "query.title": paper.title,
          rows: "1",
          select: "DOI,URL,container-title,published-print,published-online",
        });
    const url = paper.doi
      ? `${CROSSREF_BASE_URL}/${encodeURIComponent(paper.doi)}`
      : `${CROSSREF_BASE_URL}?${params}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Spexivix/0.2 (mailto:research@spexivix.local)",
      },
      next: { revalidate: 60 * 60 * 24 },
    });

    if (!response.ok) {
      return paper;
    }

    const payload = (await response.json()) as {
      message?: {
        DOI?: string;
        URL?: string;
        "container-title"?: string[];
        "published-print"?: { "date-parts"?: number[][] };
        "published-online"?: { "date-parts"?: number[][] };
        items?: Array<{
          DOI?: string;
          URL?: string;
          "container-title"?: string[];
          "published-print"?: { "date-parts"?: number[][] };
          "published-online"?: { "date-parts"?: number[][] };
        }>;
      };
    };
    const item = payload.message?.items?.[0] ?? payload.message;

    if (!item) {
      return paper;
    }

    const year =
      item["published-print"]?.["date-parts"]?.[0]?.[0] ??
      item["published-online"]?.["date-parts"]?.[0]?.[0] ??
      paper.year;
    const doi = paper.doi ?? item.DOI ?? null;

    return {
      ...paper,
      doi,
      journal: paper.journal || item["container-title"]?.[0] || "Crossref",
      sourceUrl: doi ? `https://doi.org/${doi}` : item.URL ?? paper.sourceUrl,
      year,
      metadata: {
        ...paper.metadata,
        crossrefUrl: item.URL,
      },
    };
  } catch {
    return paper;
  }
}

function mergePapers(fullTextPapers: ScientificPaper[], abstractPapers: ScientificPaper[]) {
  const merged = new Map<string, ScientificPaper>();

  for (const paper of [...fullTextPapers, ...abstractPapers]) {
    const key = getPaperMergeKey(paper);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, paper);
      continue;
    }

    const preferred = existing.fullTextSections.length >= paper.fullTextSections.length ? existing : paper;
    merged.set(key, {
      ...preferred,
      abstractSections: preferred.abstractSections.length ? preferred.abstractSections : existing.abstractSections,
      doi: preferred.doi ?? existing.doi,
      sourceUrl: preferred.sourceUrl ?? existing.sourceUrl,
      metadata: {
        ...existing.metadata,
        ...preferred.metadata,
      },
    });
  }

  return [...merged.values()];
}

async function rankChunks(context: ScientificQueryContext, papers: ScientificPaper[]): Promise<RankedChunk[]> {
  const chunks = papers.flatMap((paper) => {
    const evidenceSections = paper.fullTextSections.length ? paper.fullTextSections : paper.abstractSections;
    return evidenceSections.flatMap((section) =>
      chunkText(section.text).map((content) => ({
        paper,
        sectionHeading: section.heading,
        sectionType: section.sectionType,
        extractionSource: section.source,
        extractionNotice: getExtractionNotice(section.source),
        content,
      })),
    );
  });

  if (!chunks.length) {
    return [];
  }

  const openAiScores = await rankWithOpenAIEmbeddings(
    context,
    chunks.map((chunk) => `${chunk.paper.title}\n${chunk.sectionHeading}\n${chunk.content}`),
  );

  return chunks
    .map((chunk, index) => {
      const localScore = scoreSemanticMatch(context, [
        chunk.paper.title,
        chunk.paper.journal,
        chunk.sectionHeading,
        chunk.content,
        chunk.paper.authors.join(" "),
      ]);
      const embeddingScore = openAiScores?.[index];
      const sourceBoost = chunk.extractionSource === "full_text" ? 8 : 0;
      const sectionBoost = ["introduction", "results", "discussion", "conclusion"].includes(chunk.sectionType) ? 4 : 0;
      const score =
        embeddingScore == null
          ? clampScore(localScore + sourceBoost + sectionBoost)
          : clampScore(Math.round(localScore * 0.35 + embeddingScore * 0.65) + sourceBoost + sectionBoost);
      const highlightedTerms = getHighlightedTerms(context, chunk.content);
      const tags = deriveTags(context, chunk.content, highlightedTerms);
      const summaries = summarizeChunk(context, chunk.content, tags, chunk.sectionHeading, chunk.extractionSource);

      return {
        ...chunk,
        score,
        explanation: explainRelevance(context, chunk.content, tags, chunk.extractionSource),
        summary: summaries.scientificSummary,
        tags,
        highlightedTerms,
        ...summaries,
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function rankWithOpenAIEmbeddings(context: ScientificQueryContext, inputs: string[]): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [`${context.originalQuery}\n${context.translatedQuery}\n${context.expandedTerms.join(" ")}`, ...inputs],
      }),
    });

    if (!response.ok) {
      console.warn("OpenAI embeddings failed; falling back to local semantic ranking.");
      return null;
    }

    const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    const embeddings = payload.data?.map((item) => item.embedding);
    const queryEmbedding = embeddings?.[0];
    const chunkEmbeddings = embeddings?.slice(1);

    if (!queryEmbedding || !chunkEmbeddings?.length) {
      return null;
    }

    return chunkEmbeddings.map((embedding) => Math.round(cosineSimilarity(queryEmbedding, embedding) * 100));
  } catch (error) {
    console.warn("OpenAI embeddings skipped.", error);
    return null;
  }
}

function selectBestChunkPerPaper(chunks: RankedChunk[]) {
  const selected = new Map<string, RankedChunk>();

  for (const chunk of chunks) {
    const key = getStableJournalId(chunk.paper);
    const existing = selected.get(key);
    if (!existing || chunk.score > existing.score || (chunk.extractionSource === "full_text" && existing.extractionSource === "abstract")) {
      selected.set(key, chunk);
    }
  }

  return [...selected.values()].sort((a, b) => b.score - a.score);
}

async function persistSearchResults({
  assistant,
  context,
  rankedChunks,
  searchId,
  selectedSources,
  userId,
}: {
  assistant: ResearchAssistant;
  context: ScientificQueryContext;
  rankedChunks: RankedChunk[];
  searchId: string;
  selectedSources: string[];
  userId: string;
}): Promise<JournalSearchResult[]> {
  return await db.transaction(async (tx) => {
    await tx.insert(searches).values({
      id: searchId,
      userId,
      query: context.originalQuery,
      detectedLanguage: context.detectedLanguage,
      translatedQuery: context.translatedQuery,
      sourceCount: selectedSources.length,
      resultCount: rankedChunks.length,
      assistantMetadata: assistant,
    });

    const results: JournalSearchResult[] = [];

    for (const [index, chunk] of rankedChunks.entries()) {
      const journalId = getStableJournalId(chunk.paper);
      const sectionId = getStableSectionId(journalId, chunk.sectionHeading, chunk.content);

      await tx
        .insert(journals)
        .values({
          id: journalId,
          title: chunk.paper.title,
          authors: chunk.paper.authors,
          journalName: chunk.paper.journal,
          publicationYear: chunk.paper.year,
          doi: chunk.paper.doi,
          sourceUrl: chunk.paper.sourceUrl,
          pdfUrl: chunk.paper.pdfUrl,
          metadata: chunk.paper.metadata,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: journals.id,
          set: {
            title: chunk.paper.title,
            authors: chunk.paper.authors,
            journalName: chunk.paper.journal,
            publicationYear: chunk.paper.year,
            doi: chunk.paper.doi,
            sourceUrl: chunk.paper.sourceUrl,
            pdfUrl: chunk.paper.pdfUrl,
            metadata: chunk.paper.metadata,
            updatedAt: new Date(),
          },
        });

      await tx
        .insert(journalSections)
        .values({
          id: sectionId,
          journalId,
          heading: chunk.sectionHeading,
          sectionType: chunk.sectionType,
          extractionSource: chunk.extractionSource,
          content: chunk.content,
          summary: chunk.summary,
          tags: chunk.tags,
        })
        .onConflictDoUpdate({
          target: journalSections.id,
          set: {
            heading: chunk.sectionHeading,
            sectionType: chunk.sectionType,
            extractionSource: chunk.extractionSource,
            content: chunk.content,
            summary: chunk.summary,
            tags: chunk.tags,
          },
        });

      await tx.insert(searchResults).values({
        id: crypto.randomUUID(),
        searchId,
        journalId,
        sectionId,
        relevanceScore: chunk.score,
        highlightedText: chunk.content,
        aiSummary: chunk.summary,
        simpleExplanation: chunk.simpleExplanation,
        scientificSummary: chunk.scientificSummary,
        keyFindings: chunk.keyFindings,
        mainConclusion: chunk.mainConclusion,
        extractionSource: chunk.extractionSource,
        rank: index + 1,
      });

      results.push({
        id: journalId,
        title: chunk.paper.title,
        authors: chunk.paper.authors,
        journal: chunk.paper.journal,
        year: chunk.paper.year,
        score: chunk.score,
        doi: chunk.paper.doi,
        sourceUrl: chunk.paper.sourceUrl,
        pdfUrl: chunk.paper.pdfUrl,
        section: chunk.sectionHeading,
        sectionType: chunk.sectionType,
        extractionSource: chunk.extractionSource,
        extractionNotice: chunk.extractionNotice,
        highlight: chunk.content,
        summary: chunk.summary,
        explanation: chunk.explanation,
        simpleExplanation: chunk.simpleExplanation,
        scientificSummary: chunk.scientificSummary,
        keyFindings: chunk.keyFindings,
        mainConclusion: chunk.mainConclusion,
        tags: chunk.tags,
        highlightedTerms: chunk.highlightedTerms,
      });
    }

    return results;
  });
}

function parsePmcBodySections(body: unknown) {
  const bodyRecord = body as Record<string, unknown> | undefined;
  const sections = toArray(bodyRecord?.sec).flatMap((section) => parsePmcSection(section));
  const canonical = sections.filter((section) =>
    ["introduction", "methods", "results", "discussion", "conclusion"].includes(section.sectionType),
  );
  const selected = canonical.length >= 3 ? canonical : sections;

  return selected
    .filter((section) => section.text.length > 120)
    .slice(0, 24);
}

function parsePmcSection(section: unknown, inheritedHeading?: string): PaperSection[] {
  const value = section as Record<string, unknown>;
  const heading = cleanText(getPlainText(value.title) || inheritedHeading || "Full text");
  const paragraphs = toArray(value.p)
    .map(getPlainText)
    .map(cleanText)
    .filter((paragraph) => paragraph.length > 40);
  const ownText = paragraphs.join(" ");
  const childSections = toArray(value.sec).flatMap((child) => parsePmcSection(child, heading));
  const sections: PaperSection[] = [];

  if (ownText.length > 80) {
    sections.push({
      heading,
      sectionType: inferSectionType(heading),
      source: "full_text",
      text: ownText,
    });
  }

  return [...sections, ...childSections];
}

function parsePmcAbstract(abstractData: unknown) {
  const sections = toArray(abstractData)
    .flatMap((abstract) => {
      const value = abstract as Record<string, unknown>;
      const secChildren = toArray(value.sec);
      if (secChildren.length) {
        return secChildren.map((section) => {
          const sectionValue = section as Record<string, unknown>;
          const heading = cleanText(getPlainText(sectionValue.title) || "Abstract");
          return {
            heading,
            sectionType: inferSectionType(heading, "abstract"),
            source: "abstract" as const,
            text: cleanText(getPlainText(sectionValue.p ?? sectionValue)),
          };
        });
      }

      return [
        {
          heading: "Abstract",
          sectionType: "abstract",
          source: "abstract" as const,
          text: cleanText(getPlainText(value.p ?? value)),
        },
      ];
    })
    .filter((section) => section.text.length > 60);

  return sections;
}

function parsePubMedAbstract(abstractData: unknown): PaperSection[] {
  const abstractText = (abstractData as Record<string, unknown> | undefined)?.AbstractText;
  const sections = toArray(abstractText)
    .map((section) => {
      if (typeof section === "string" || typeof section === "number") {
        return {
          heading: "Abstract",
          sectionType: "abstract",
          source: "abstract" as const,
          text: cleanText(String(section)),
        };
      }

      const value = section as Record<string, unknown>;
      const heading = cleanText(String(value.Label ?? value.NlmCategory ?? "Abstract"));
      const text = cleanText(getPlainText(value["#text"] ?? value));
      return {
        heading,
        sectionType: inferSectionType(heading, "abstract"),
        source: "abstract" as const,
        text,
      };
    })
    .filter((section) => section.text && section.text !== "[object Object]");

  return sections.length ? sections : [];
}

function parsePmcAuthors(contribGroup: unknown) {
  const groups = toArray(contribGroup as unknown);
  const contributors = groups.flatMap((group) => toArray((group as Record<string, unknown>)?.contrib));

  return contributors
    .filter((contrib) => String((contrib as Record<string, unknown>)["contrib-type"] ?? "author") === "author")
    .map((contrib) => {
      const value = contrib as Record<string, unknown>;
      const name = value.name as Record<string, unknown> | undefined;
      const collab = value.collab;
      if (collab) {
        return cleanText(getPlainText(collab));
      }

      return cleanText([getPlainText(name?.["given-names"]), getPlainText(name?.surname)].filter(Boolean).join(" "));
    })
    .filter(Boolean)
    .slice(0, 8);
}

function parsePubMedAuthors(authorList: unknown) {
  return toArray((authorList as Record<string, unknown> | undefined)?.Author)
    .map((author) => {
      const value = author as Record<string, unknown>;
      const collectiveName = value.CollectiveName;
      if (collectiveName) {
        return cleanText(String(collectiveName));
      }

      return cleanText([value.ForeName, value.LastName].filter(Boolean).join(" "));
    })
    .filter(Boolean)
    .slice(0, 8);
}

function parsePmcYear(pubDate: unknown) {
  const dates = toArray(pubDate);
  for (const date of dates) {
    const year = Number((date as Record<string, unknown>)?.year);
    if (Number.isFinite(year)) {
      return year;
    }
  }

  return new Date().getFullYear();
}

function parsePubMedYear(journalIssue: unknown) {
  const pubDate = (journalIssue as Record<string, unknown> | undefined)?.PubDate as
    | Record<string, unknown>
    | undefined;
  const explicitYear = Number(pubDate?.Year);
  if (Number.isFinite(explicitYear)) {
    return explicitYear;
  }

  const match = String(pubDate?.MedlineDate ?? "").match(/\d{4}/);
  return match ? Number(match[0]) : new Date().getFullYear();
}

function getArticleId(articleIdList: unknown, idType: string) {
  const articleIds = toArray((articleIdList as Record<string, unknown> | undefined)?.ArticleId ?? articleIdList);
  for (const articleId of articleIds) {
    if (typeof articleId === "string" || typeof articleId === "number") {
      continue;
    }

    const value = articleId as Record<string, unknown>;
    const type = String(value.IdType ?? value["pub-id-type"] ?? "").toLowerCase();
    if (type === idType) {
      return cleanText(getPlainText(value["#text"] ?? ""));
    }
  }

  return null;
}

function expandPubMedQuery(context: ScientificQueryContext) {
  const tokens = tokenize(context.normalizedQuery);
  const clauses = new Set<string>(context.searchQueries.map((term) => `"${term}"`));
  const mentionsNox = tokens.some((token) => ["nox", "nox2", "nox4", "nadph", "oxidase"].includes(token));
  const mentionsLung = tokens.some((token) => ["lung", "lungs", "pulmonary", "airway", "alveolar", "respiratory"].includes(token));
  const mentionsInflammation = tokens.some((token) => ["inflammation", "inflammatory", "cytokine", "immune"].includes(token));

  if (mentionsNox && mentionsLung) {
    clauses.add(`("NADPH oxidase" OR NOX2 OR NOX4) AND (lung OR pulmonary OR airway OR alveolar)`);
  }

  if (mentionsNox && mentionsInflammation) {
    clauses.add(`("NADPH oxidase" OR NOX2 OR NOX4) AND (inflammation OR inflammatory OR cytokine)`);
  }

  if (mentionsLung && mentionsInflammation) {
    clauses.add(`("pulmonary inflammation" OR "lung inflammation" OR "airway inflammation")`);
  }

  if (tokens.includes("ros") || tokens.includes("oxidative")) {
    clauses.add(`("reactive oxygen species" OR ROS OR "oxidative stress") AND (lung OR pulmonary OR inflammation)`);
  }

  return [...clauses].join(" OR ");
}

function buildScientificFallbackQuery(normalizedQuery: string) {
  const tokens = tokenize(normalizedQuery);
  const expanded = [...expandTerms(tokens)];
  const priority = expanded.filter((token) =>
    ["nox", "nox2", "nox4", "nadph", "oxidase", "ros", "oxidative", "lung", "pulmonary", "inflammation"].includes(token),
  );

  return uniqueStrings([...priority, ...tokens]).slice(0, 10).join(" ");
}

function chunkText(text: string) {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > 1000 && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length ? chunks : [text];
}

function scoreSemanticMatch(context: ScientificQueryContext, fields: string[]) {
  const coreTerms = tokenize(context.normalizedQuery);
  const expandedTerms = expandTerms(coreTerms);
  const text = fields.join(" ").toLowerCase();
  const textTerms = new Set(tokenize(text));
  let rawScore = 0;

  for (const term of coreTerms) {
    if (textTerms.has(term)) {
      rawScore += 10;
    } else if (text.includes(term)) {
      rawScore += 5;
    }
  }

  for (const term of expandedTerms) {
    if (coreTerms.includes(term)) {
      continue;
    }

    if (textTerms.has(term)) {
      rawScore += 3;
    } else if (text.includes(term)) {
      rawScore += 1;
    }
  }

  for (const phrase of [
    "nadph oxidase",
    "reactive oxygen species",
    "pulmonary inflammation",
    "oxidative stress",
    "alveolar macrophages",
    "airway inflammation",
  ]) {
    if (text.includes(phrase) && phraseMatchesQuery(phrase, tokenize(context.normalizedQuery))) {
      rawScore += 16;
    }
  }

  const noxIntent = coreTerms.some((term) => ["nox", "nox2", "nox4", "nadph", "oxidase"].includes(term));
  const noxMatched = ["nox", "nox2", "nox4", "nadph", "oxidase"].some((term) => textTerms.has(term) || text.includes(term));
  if (noxIntent && !noxMatched) {
    rawScore -= 15;
  }

  return Math.round(Math.min(96, Math.max(30, 30 + (rawScore / 95) * 66)));
}

function getHighlightedTerms(context: ScientificQueryContext, content: string) {
  const contentLower = content.toLowerCase();
  return uniqueStrings([...expandTerms(tokenize(context.normalizedQuery)), ...context.expandedTerms])
    .filter((term) => term.length > 2 && contentLower.includes(term.toLowerCase()))
    .slice(0, 10);
}

function deriveTags(context: ScientificQueryContext, content: string, highlightedTerms: string[]) {
  const tags = new Set<string>();
  const lower = `${context.normalizedQuery} ${content}`.toLowerCase();

  for (const tag of [
    ["NOX", ["nox", "nadph oxidase"]],
    ["ROS", ["ros", "reactive oxygen species"]],
    ["Oxidative stress", ["oxidative stress", "oxidative"]],
    ["Pulmonary inflammation", ["pulmonary", "lung", "inflammation"]],
    ["Macrophages", ["macrophage", "macrophages"]],
    ["Cytokines", ["cytokine", "il-6", "tnf"]],
    ["Airway biology", ["airway", "alveolar", "respiratory"]],
  ] as const) {
    if (tag[1].some((term) => lower.includes(term))) {
      tags.add(tag[0]);
    }
  }

  for (const term of highlightedTerms.slice(0, 3)) {
    tags.add(toTitleCase(term));
  }

  return [...tags].slice(0, 6);
}

function summarizeChunk(
  context: ScientificQueryContext,
  content: string,
  tags: string[],
  sectionHeading: string,
  extractionSource: ExtractionSource,
): SummaryBundle {
  const sentences = splitSentences(content);
  const rankedSentences = [...sentences].sort((a, b) => scoreSentence(context, b) - scoreSentence(context, a));
  const bestSentences = uniqueStrings(rankedSentences.slice(0, 3));
  const keyFindings = bestSentences.length ? bestSentences.map(trimSentence).slice(0, 3) : [trimSentence(content)];
  const conceptText = tags.length ? tags.slice(0, 3).join(", ") : context.expandedTerms.slice(0, 3).join(", ");
  const evidenceLabel = extractionSource === "full_text" ? `the ${sectionHeading} section` : "the abstract";

  return {
    simpleExplanation: conceptText
      ? `In simple terms, this paper connects ${conceptText} with the user's research question using evidence from ${evidenceLabel}.`
      : `In simple terms, this paper contains language that closely matches the user's research question.`,
    scientificSummary: `${keyFindings.slice(0, 2).join(" ")}${keyFindings.length ? "" : trimSentence(content)}`.slice(0, 520),
    keyFindings,
    mainConclusion: pickConclusionSentence(sentences, keyFindings),
  };
}

function explainRelevance(
  context: ScientificQueryContext,
  content: string,
  tags: string[],
  extractionSource: ExtractionSource,
) {
  const terms = tags.length ? tags.slice(0, 3).join(", ") : getHighlightedTerms(context, content).slice(0, 3).join(", ");
  const evidence = extractionSource === "full_text" ? "full-text paragraph" : "abstract paragraph";
  return terms
    ? `This ${evidence} is relevant because it discusses ${terms} in language that matches the scientific intent of "${context.translatedQuery}".`
    : `This ${evidence} is relevant because its meaning is semantically close to "${context.translatedQuery}".`;
}

function buildResearchAssistant(context: ScientificQueryContext, chunks: RankedChunk[]): ResearchAssistant {
  const tags = uniqueStrings(chunks.flatMap((chunk) => chunk.tags));
  const relatedConcepts = uniqueStrings([
    ...tags,
    ...context.expandedTerms.filter((term) =>
      ["nox", "nadph", "oxidase", "ros", "oxidative", "pulmonary", "airway", "inflammation", "macrophage"].includes(term),
    ),
  ])
    .map(toTitleCase)
    .slice(0, 8);
  const relatedKeywords = uniqueStrings([
    ...context.expandedTerms,
    ...chunks.flatMap((chunk) => chunk.highlightedTerms),
  ]).slice(0, 12);
  const focus = context.translatedQuery || context.originalQuery;

  return {
    detectedLanguage: context.detectedLanguage,
    translatedQuery: context.translatedQuery,
    relatedConcepts,
    relatedKeywords,
    suggestedFollowUps: [
      `${focus} mechanisms`,
      `${focus} in animal models`,
      `${focus} therapeutic targets`,
      `${focus} clinical evidence`,
    ].slice(0, 4),
    relatedTopics: uniqueStrings([
      "Oxidative stress signaling",
      "Inflammatory cytokine pathways",
      "Pulmonary immune cell activation",
      "Open-access full-text evidence",
      ...tags.map((tag) => `${tag} literature`),
    ]).slice(0, 6),
  };
}

function normalizeAssistantMetadata(
  value: Record<string, unknown>,
  context: ScientificQueryContext,
  results: JournalSearchResult[],
): ResearchAssistant {
  const fallback = buildResearchAssistant(
    context,
    results.map((result) => ({
      tags: result.tags,
      highlightedTerms: result.highlightedTerms,
    })) as RankedChunk[],
  );

  return {
    detectedLanguage: String(value?.detectedLanguage ?? fallback.detectedLanguage),
    translatedQuery: String(value?.translatedQuery ?? fallback.translatedQuery),
    relatedConcepts: toStringArray(value?.relatedConcepts, fallback.relatedConcepts),
    relatedKeywords: toStringArray(value?.relatedKeywords, fallback.relatedKeywords),
    suggestedFollowUps: toStringArray(value?.suggestedFollowUps, fallback.suggestedFollowUps),
    relatedTopics: toStringArray(value?.relatedTopics, fallback.relatedTopics),
  };
}

function deriveSources(chunks: RankedChunk[], fullTextPaperCount: number) {
  const sources = new Set<string>();
  if (chunks.some((chunk) => chunk.extractionSource === "full_text") || fullTextPaperCount > 0) {
    sources.add("PubMed Central full text");
  }
  if (chunks.some((chunk) => chunk.extractionSource === "abstract")) {
    sources.add("PubMed abstracts");
  }
  if (chunks.some((chunk) => chunk.paper.doi)) {
    sources.add("Crossref metadata");
  }

  return sources.size ? [...sources] : ["PubMed", "PubMed Central"];
}

function getExtractionNotice(source: ExtractionSource) {
  return source === "full_text" ? "Result extracted from full text." : "Result extracted from abstract.";
}

function inferSectionType(heading: string, fallback = "full_text") {
  const lower = heading.toLowerCase();
  if (/intro|background/.test(lower)) {
    return "introduction";
  }
  if (/method|material|experimental|protocol/.test(lower)) {
    return "methods";
  }
  if (/result|finding|observation/.test(lower)) {
    return "results";
  }
  if (/discussion|interpretation/.test(lower)) {
    return "discussion";
  }
  if (/conclusion|summary|final/.test(lower)) {
    return "conclusion";
  }
  if (/abstract/.test(lower)) {
    return "abstract";
  }

  return fallback;
}

function normalizeScientificQuery(query: string) {
  return cleanText(query)
    .replace(/\bNADPH[-\s]?oxidase\b/gi, "NADPH oxidase")
    .replace(/\breactive oxygen species\b/gi, "reactive oxygen species")
    .replace(/\bROS\b/g, "ROS")
    .replace(/\bNOX\b/g, "NOX");
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function expandTerms(tokens: string[]) {
  const terms = new Set(tokens);
  for (const token of tokens) {
    for (const expansion of semanticExpansions[token] ?? []) {
      terms.add(expansion);
    }
  }

  return terms;
}

function phraseMatchesQuery(phrase: string, tokens: string[]) {
  const phraseTokens = tokenize(phrase);
  return phraseTokens.some((token) => tokens.includes(token) || tokens.some((source) => semanticExpansions[source]?.includes(token)));
}

function splitSentences(value: string) {
  return value
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
}

function scoreSentence(context: ScientificQueryContext, sentence: string) {
  const lower = sentence.toLowerCase();
  return context.expandedTerms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function trimSentence(value: string) {
  const trimmed = cleanText(value);
  return trimmed.length > 260 ? `${trimmed.slice(0, 257)}...` : trimmed;
}

function pickConclusionSentence(sentences: string[], keyFindings: string[]) {
  const conclusion = sentences.find((sentence) => /conclud|suggest|indicat|demonstrat|therefore|overall/i.test(sentence));
  return trimSentence(conclusion ?? keyFindings[keyFindings.length - 1] ?? sentences[sentences.length - 1] ?? "");
}

function clampScore(value: number) {
  return Math.round(Math.min(99, Math.max(35, value)));
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getStableJournalId(paper: ScientificPaper) {
  if (paper.doi) {
    return `doi_${hashStable(paper.doi.toLowerCase())}`;
  }

  if (paper.metadata.pubmedId) {
    return `pubmed_${paper.metadata.pubmedId}`;
  }

  return `paper_${hashStable(paper.id || paper.title)}`;
}

function getStableSectionId(journalId: string, heading: string, content: string) {
  return `section_${hashStable(`${journalId}:${heading}:${content.slice(0, 180)}`)}`;
}

function getPaperMergeKey(paper: ScientificPaper) {
  return paper.doi?.toLowerCase() ?? (String(paper.metadata.pubmedId ?? "") || hashStable(paper.title.toLowerCase()));
}

function hashStable(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function cleanText(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function getPlainText(value: unknown): string {
  if (value == null) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(getPlainText).filter(Boolean).join(" ");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    if (record["#text"]) {
      parts.push(getPlainText(record["#text"]));
    }

    for (const [key, nested] of Object.entries(record)) {
      if (
        key === "#text" ||
        key.startsWith("@") ||
        ["id", "rid", "ref-type", "sec-type", "contrib-type", "pub-id-type", "IdType"].includes(key)
      ) {
        continue;
      }
      parts.push(getPlainText(nested));
    }

    return parts.filter(Boolean).join(" ");
  }

  return "";
}

function getTextValue(value: unknown) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  if (typeof value === "object" && "#text" in value) {
    return String((value as Record<string, unknown>)["#text"] ?? "");
  }

  return String(value);
}

function normalizePmcId(value: string | null) {
  if (!value) {
    return null;
  }

  return value.toUpperCase().startsWith("PMC") ? value.toUpperCase() : `PMC${value}`;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => cleanText(String(value ?? ""))).filter(Boolean))];
}

function toStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value.map((item) => String(item)).filter(Boolean);
}

function toTitleCase(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
