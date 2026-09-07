import { XMLParser } from "fast-xml-parser";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  evidenceChunks,
  journalSections,
  journals,
  paperParagraphs,
  paperSources,
  searchJobs,
  searches,
  searchResults,
} from "@/db/schema";

const NCBI_BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const EUROPE_PMC_BASE_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const CROSSREF_BASE_URL = "https://api.crossref.org/works";
const OPENALEX_BASE_URL = "https://api.openalex.org/works";
const SEMANTIC_SCHOLAR_BASE_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const ARXIV_BASE_URL = "https://export.arxiv.org/api/query";
const VECTOR_DIMENSIONS = 3072;
const RESULT_LIMIT = 8;

export const evidenceJobSteps = [
  "Searching literature...",
  "Reading papers...",
  "Extracting evidence...",
  "Ranking evidence...",
  "Generating answer...",
] as const;

type EvidenceStatus = "queued" | "running" | "completed" | "failed";
type ExtractionSource = "full_text" | "abstract";

type QueryContext = {
  originalQuery: string;
  detectedLanguage: string;
  translatedQuery: string;
  expandedTerms: string[];
  searchTerms: string[];
  answerLanguage: string;
};

type SourcePaper = {
  id: string;
  provider: string;
  providerPaperId?: string | null;
  title: string;
  authors: string[];
  journal: string;
  year: number;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  arxivId: string | null;
  sourceUrl: string | null;
  pdfUrl: string | null;
  isOpenAccess: boolean;
  hasFullText: boolean;
  abstractText: string | null;
  metadata: Record<string, unknown>;
};

type ParsedSection = {
  name: string;
  type: string;
  subsection: string | null;
  paragraphs: Array<{
    text: string;
    position: number;
    pageNumber: number | null;
  }>;
  source: ExtractionSource;
};

export type EvidenceBlock = {
  resultId: string;
  journalId: string;
  chunkId: string;
  title: string;
  authors: string[];
  journal: string;
  year: number;
  doi: string | null;
  sourceUrl: string | null;
  pdfUrl: string | null;
  section: string;
  subsection: string | null;
  pageNumber: number | null;
  paragraphNumber: number | null;
  paragraph: string;
  highlightedSpan: string;
  score: number;
  confidenceLabel: "Direct Evidence" | "Strong Evidence" | "Supporting Evidence";
  citation: string;
  extractionSource: ExtractionSource;
};

export type EvidenceSearchResult = {
  searchId: string;
  jobId?: string;
  query: string;
  detectedLanguage: string;
  translatedQuery: string;
  answer: string;
  confidenceLabel: string;
  keyFindings: string[];
  conclusion: string;
  citations: string[];
  sources: string[];
  evidence: EvidenceBlock[];
  status: EvidenceStatus;
};

export async function getEvidenceDatabaseReadiness() {
  try {
    const extensionRows = (await db.execute(sql`
      select exists(select 1 from pg_extension where extname = 'vector') as "exists"
    `)) as unknown as Array<{ exists: boolean }>;
    const tableRows = (await db.execute(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      and table_name in ('search_jobs', 'paper_sources', 'paper_paragraphs', 'evidence_chunks', 'saved_evidence')
    `)) as unknown as Array<{ table_name: string }>;
    const existingTables = new Set(tableRows.map((row) => row.table_name));
    const missingTables = ["search_jobs", "paper_sources", "paper_paragraphs", "evidence_chunks", "saved_evidence"]
      .filter((table) => !existingTables.has(table));
    const hasPgvector = Boolean(extensionRows[0]?.exists);

    if (!hasPgvector || missingTables.length) {
      return {
        ready: false,
        message:
          "Evidence search database is not ready. Start the pgvector Postgres service with `docker compose up -d --force-recreate postgres`, then run `npm run db:migrate`.",
        details: {
          pgvectorInstalled: hasPgvector,
          missingTables,
        },
      };
    }

    return { ready: true, message: "Evidence database is ready.", details: { missingTables: [] as string[] } };
  } catch (error) {
    return {
      ready: false,
      message:
        "Evidence search database could not be checked. Make sure PostgreSQL is running on localhost:5432 and run `npm run db:migrate`.",
      details: {
        error: error instanceof Error ? error.message : "Unknown database readiness error.",
      },
    };
  }
}

const xmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
});

const scientificSynonyms: Record<string, string[]> = {
  nox: ["NADPH oxidase", "NOX2", "NOX4", "reactive oxygen species", "oxidative stress"],
  ros: ["reactive oxygen species", "oxidative stress", "redox signaling"],
  copd: ["chronic obstructive pulmonary disease", "airway inflammation", "emphysema"],
  lung: ["pulmonary", "airway", "alveolar", "respiratory"],
  inflammation: ["inflammatory response", "cytokines", "IL-6", "TNF-alpha", "immune response"],
  macrophage: ["alveolar macrophage", "phagocyte", "innate immunity"],
  microplastic: ["microplastics", "particulate matter", "environmental particles"],
  bos: ["bronchiolitis obliterans syndrome", "lung transplantation", "airway remodeling"],
};

const glossary: Array<[RegExp, string]> = [
  [/\bperan\b/gi, "role"],
  [/\bdalam\b/gi, "in"],
  [/\binflamasi\b/gi, "inflammation"],
  [/\bparu[-\s]?paru\b/gi, "lung"],
  [/\bparu\b/gi, "lung"],
  [/\bmakrofag\b/gi, "macrophage"],
  [/\bstres oksidatif\b/gi, "oxidative stress"],
  [/\bspesies oksigen reaktif\b/gi, "reactive oxygen species"],
  [/\binflamaci[oó]n\b/gi, "inflammation"],
  [/\bpulm[oó]n\b/gi, "lung"],
  [/\bpulmonar\b/gi, "pulmonary"],
  [/\br[oô]le\b/gi, "role"],
  [/\bpoumon\b/gi, "lung"],
  [/\bentz[uü]ndung\b/gi, "inflammation"],
  [/\blunge\b/gi, "lung"],
  [/\binflama[cç][aã]o\b/gi, "inflammation"],
  [/\bpulm[aã]o\b/gi, "lung"],
];

export async function createEvidenceSearchJob({
  query,
  userId,
}: {
  query: string;
  userId: string;
}) {
  const context = await understandQuery(query);
  const jobId = crypto.randomUUID();

  await db.insert(searchJobs).values({
    id: jobId,
    userId,
    query,
    detectedLanguage: context.detectedLanguage,
    translatedQuery: context.translatedQuery,
    expandedTerms: context.expandedTerms,
    status: "queued",
    currentStep: evidenceJobSteps[0],
    progress: 0,
    updatedAt: new Date(),
  });

  return {
    jobId,
    status: "queued" as const,
    currentStep: evidenceJobSteps[0],
    progress: 0,
    detectedLanguage: context.detectedLanguage,
    translatedQuery: context.translatedQuery,
    expandedTerms: context.expandedTerms,
  };
}

export async function getEvidenceSearchJob(jobId: string, userId: string) {
  const [job] = await db
    .select()
    .from(searchJobs)
    .where(and(eq(searchJobs.id, jobId), eq(searchJobs.userId, userId)))
    .limit(1);

  return job ?? null;
}

export async function processEvidenceSearchJob(jobId: string) {
  const [job] = await db.select().from(searchJobs).where(eq(searchJobs.id, jobId)).limit(1);
  if (!job || job.status === "running" || job.status === "completed") {
    return;
  }

  try {
    await updateJob(jobId, "running", evidenceJobSteps[0], 8);
    const result = await runEvidenceSearch({
      jobId,
      query: job.query,
      userId: job.userId ?? "",
      onProgress: (step, progress) => updateJob(jobId, "running", step, progress),
    });

    await db
      .update(searchJobs)
      .set({
        searchId: result.searchId,
        status: "completed",
        currentStep: "Evidence ready.",
        progress: 100,
        result,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(searchJobs.id, jobId));
  } catch (error) {
    await db
      .update(searchJobs)
      .set({
        status: "failed",
        currentStep: "Search failed.",
        progress: 100,
        error: error instanceof Error ? error.message : "Evidence search failed.",
        updatedAt: new Date(),
      })
      .where(eq(searchJobs.id, jobId));
  }
}

export async function runEvidenceSearch({
  jobId,
  query,
  userId,
  onProgress,
}: {
  jobId?: string;
  query: string;
  userId: string;
  onProgress?: (step: string, progress: number) => Promise<void>;
}): Promise<EvidenceSearchResult> {
  const context = await understandQuery(query);
  await onProgress?.(evidenceJobSteps[0], 15);

  const discovered = await discoverScientificSources(context);
  await onProgress?.(evidenceJobSteps[1], 35);

  const acquired = await acquireReadablePapers(discovered);
  await onProgress?.(evidenceJobSteps[2], 55);

  const { journalIds, chunkIds } = await indexPapers(acquired);
  const rankedEvidence = await retrieveAndRankEvidence(context, journalIds, chunkIds);
  await onProgress?.(evidenceJobSteps[3], 78);

  const grounded = await generateGroundedAnswer(context, rankedEvidence);
  await onProgress?.(evidenceJobSteps[4], 92);

  const searchId = await persistSearch(context, grounded, userId, rankedEvidence);

  return {
    searchId,
    jobId,
    query,
    detectedLanguage: context.detectedLanguage,
    translatedQuery: context.translatedQuery,
    answer: grounded.answer,
    confidenceLabel: grounded.confidenceLabel,
    keyFindings: grounded.keyFindings,
    conclusion: grounded.conclusion,
    citations: grounded.citations,
    sources: Array.from(new Set(rankedEvidence.map((item) => item.extractionSource === "full_text" ? "Full text evidence" : "Abstract evidence"))),
    evidence: rankedEvidence,
    status: "completed",
  };
}

async function updateJob(jobId: string, status: EvidenceStatus, currentStep: string, progress: number) {
  await db
    .update(searchJobs)
    .set({ status, currentStep, progress, updatedAt: new Date() })
    .where(eq(searchJobs.id, jobId));
}

async function understandQuery(query: string): Promise<QueryContext> {
  const detectedLanguage = detectLanguage(query);
  const translatedQuery = await translateWithOpenAI(query, detectedLanguage) ?? translateLocally(query);
  const expandedTerms = expandScientificTerms(`${query} ${translatedQuery}`);
  const searchTerms = unique([
    translatedQuery,
    query,
    `${translatedQuery} ${expandedTerms.slice(0, 8).join(" ")}`,
  ]).filter((term) => term.length > 2);

  return {
    originalQuery: query,
    detectedLanguage,
    translatedQuery,
    expandedTerms,
    searchTerms,
    answerLanguage: detectedLanguage,
  };
}

async function discoverScientificSources(context: QueryContext): Promise<SourcePaper[]> {
  const [pmc, pubmed, europePmc, crossref, openAlex, semanticScholar, arxiv] = await Promise.all([
    discoverPmc(context),
    discoverPubMed(context),
    discoverEuropePmc(context),
    discoverCrossref(context),
    discoverOpenAlex(context),
    discoverSemanticScholar(context),
    discoverArxiv(context),
  ]);

  return dedupePapers([...pmc, ...europePmc, ...pubmed, ...openAlex, ...semanticScholar, ...crossref, ...arxiv]).slice(0, 24);
}

async function discoverPmc(context: QueryContext) {
  const ids = await fetchNcbiIds("pmc", buildSourceQuery(context), 10);
  if (!ids.length) {
    return [];
  }

  return fetchPmcMetadata(ids);
}

async function discoverPubMed(context: QueryContext) {
  const ids = await fetchNcbiIds("pubmed", buildSourceQuery(context), 18);
  if (!ids.length) {
    return [];
  }

  return fetchPubMedMetadata(ids);
}

async function fetchNcbiIds(dbName: "pmc" | "pubmed", term: string, retmax: number) {
  const params = new URLSearchParams({ db: dbName, term, retmode: "json", sort: "relevance", retmax: String(retmax) });
  const response = await fetch(`${NCBI_BASE_URL}/esearch.fcgi?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "Spexivix-EDE/0.1" },
    next: { revalidate: 60 * 60 },
  });
  if (!response.ok) {
    return [];
  }

  const payload = await response.json() as { esearchresult?: { idlist?: string[] } };
  return payload.esearchresult?.idlist ?? [];
}

async function fetchPmcMetadata(ids: string[]): Promise<SourcePaper[]> {
  const articles = await fetchPmcXml(ids);
  return articles.map((article) => parsePmcArticle(article)).filter(Boolean) as SourcePaper[];
}

async function fetchPubMedMetadata(ids: string[]): Promise<SourcePaper[]> {
  const params = new URLSearchParams({ db: "pubmed", id: ids.join(","), retmode: "xml" });
  const response = await fetch(`${NCBI_BASE_URL}/efetch.fcgi?${params}`, {
    headers: { Accept: "application/xml", "User-Agent": "Spexivix-EDE/0.1" },
    next: { revalidate: 60 * 60 },
  });
  if (!response.ok) {
    return [];
  }

  const parsed = xmlParser.parse(await response.text()) as { PubmedArticleSet?: { PubmedArticle?: unknown[] | unknown } };
  return toArray(parsed.PubmedArticleSet?.PubmedArticle).map(parsePubMedArticle).filter(Boolean) as SourcePaper[];
}

async function discoverEuropePmc(context: QueryContext): Promise<SourcePaper[]> {
  try {
    const params = new URLSearchParams({ query: buildSourceQuery(context), format: "json", pageSize: "8", resultType: "core" });
    const response = await fetch(`${EUROPE_PMC_BASE_URL}/search?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "Spexivix-EDE/0.1" },
      next: { revalidate: 60 * 60 },
    });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as { resultList?: { result?: Array<Record<string, unknown>> } };
    return (payload.resultList?.result ?? []).map((item) => ({
      id: String(item.pmcid ?? item.pmid ?? item.doi ?? item.id ?? item.title),
      provider: "Europe PMC",
      providerPaperId: String(item.id ?? ""),
      title: clean(String(item.title ?? "")),
      authors: parseAuthorString(String(item.authorString ?? "")),
      journal: clean(String(item.journalTitle ?? item.source ?? "Europe PMC")),
      year: Number(String(item.pubYear ?? new Date().getFullYear()).slice(0, 4)),
      doi: item.doi ? clean(String(item.doi)) : null,
      pmid: item.pmid ? String(item.pmid) : null,
      pmcid: item.pmcid ? normalizePmcId(String(item.pmcid)) : null,
      arxivId: null,
      sourceUrl: item.pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${normalizePmcId(String(item.pmcid))}/` : String(item.fullTextUrlList ?? "") || null,
      pdfUrl: null,
      isOpenAccess: String(item.isOpenAccess ?? "").toLowerCase() === "y",
      hasFullText: Boolean(item.pmcid) || String(item.hasTextMinedTerms ?? "").toLowerCase() === "y",
      abstractText: item.abstractText ? clean(String(item.abstractText)) : null,
      metadata: { provider: "Europe PMC", rawSource: item.source },
    })).filter((paper) => paper.title);
  } catch {
    return [];
  }
}

async function discoverCrossref(context: QueryContext): Promise<SourcePaper[]> {
  try {
    const params = new URLSearchParams({ query: context.translatedQuery, rows: "5" });
    const response = await fetch(`${CROSSREF_BASE_URL}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "Spexivix-EDE/0.1 (mailto:research@spexivix.local)" },
      next: { revalidate: 60 * 60 * 24 },
    });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as { message?: { items?: Array<Record<string, unknown>> } };
    return (payload.message?.items ?? []).map((item) => crossrefItemToPaper(item)).filter(Boolean) as SourcePaper[];
  } catch {
    return [];
  }
}

async function discoverOpenAlex(context: QueryContext): Promise<SourcePaper[]> {
  try {
    const params = new URLSearchParams({ search: context.translatedQuery, per_page: "5" });
    const response = await fetch(`${OPENALEX_BASE_URL}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "Spexivix-EDE/0.1" },
      next: { revalidate: 60 * 60 * 24 },
    });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as { results?: Array<Record<string, unknown>> };
    return (payload.results ?? []).map((item) => {
      const primaryLocation = item.primary_location as Record<string, unknown> | undefined;
      const source = primaryLocation?.source as Record<string, unknown> | undefined;
      const openAccess = item.open_access as Record<string, unknown> | undefined;
      return {
        id: String(item.id ?? item.doi ?? item.title),
        provider: "OpenAlex",
        providerPaperId: String(item.id ?? ""),
        title: clean(String(item.title ?? item.display_name ?? "")),
        authors: [],
        journal: clean(String(source?.display_name ?? "OpenAlex")),
        year: Number(item.publication_year ?? new Date().getFullYear()),
        doi: item.doi ? clean(String(item.doi).replace(/^https:\/\/doi.org\//, "")) : null,
        pmid: null,
        pmcid: null,
        arxivId: null,
        sourceUrl: String(item.id ?? ""),
        pdfUrl: primaryLocation?.pdf_url ? String(primaryLocation.pdf_url) : null,
        isOpenAccess: Boolean(openAccess?.is_oa),
        hasFullText: Boolean(primaryLocation?.pdf_url || openAccess?.oa_url),
        abstractText: null,
        metadata: { provider: "OpenAlex" },
      } satisfies SourcePaper;
    }).filter((paper) => paper.title);
  } catch {
    return [];
  }
}

async function discoverSemanticScholar(context: QueryContext): Promise<SourcePaper[]> {
  try {
    const params = new URLSearchParams({
      query: context.translatedQuery,
      limit: "5",
      fields: "title,authors,year,journal,externalIds,url,openAccessPdf,abstract",
    });
    const response = await fetch(`${SEMANTIC_SCHOLAR_BASE_URL}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "Spexivix-EDE/0.1" },
      next: { revalidate: 60 * 60 },
    });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as { data?: Array<Record<string, unknown>> };
    return (payload.data ?? []).map((item) => {
      const externalIds = item.externalIds as Record<string, unknown> | undefined;
      const openPdf = item.openAccessPdf as Record<string, unknown> | undefined;
      const journal = item.journal as Record<string, unknown> | undefined;
      return {
        id: String(item.paperId ?? externalIds?.DOI ?? item.title),
        provider: "Semantic Scholar",
        providerPaperId: String(item.paperId ?? ""),
        title: clean(String(item.title ?? "")),
        authors: toArray(item.authors).map((author) => clean(String((author as Record<string, unknown>).name ?? ""))).filter(Boolean),
        journal: clean(String(journal?.name ?? "Semantic Scholar")),
        year: Number(item.year ?? new Date().getFullYear()),
        doi: externalIds?.DOI ? clean(String(externalIds.DOI)) : null,
        pmid: externalIds?.PubMed ? String(externalIds.PubMed) : null,
        pmcid: externalIds?.PubMedCentral ? normalizePmcId(String(externalIds.PubMedCentral)) : null,
        arxivId: externalIds?.ArXiv ? String(externalIds.ArXiv) : null,
        sourceUrl: item.url ? String(item.url) : null,
        pdfUrl: openPdf?.url ? String(openPdf.url) : null,
        isOpenAccess: Boolean(openPdf?.url),
        hasFullText: Boolean(openPdf?.url),
        abstractText: item.abstract ? clean(String(item.abstract)) : null,
        metadata: { provider: "Semantic Scholar" },
      } satisfies SourcePaper;
    }).filter((paper) => paper.title);
  } catch {
    return [];
  }
}

async function discoverArxiv(context: QueryContext): Promise<SourcePaper[]> {
  if (!/\b(physics|math|computer|algorithm|machine|astronomy|arxiv)\b/i.test(context.translatedQuery)) {
    return [];
  }

  try {
    const params = new URLSearchParams({ search_query: `all:${context.translatedQuery}`, start: "0", max_results: "5" });
    const response = await fetch(`${ARXIV_BASE_URL}?${params}`, {
      headers: { Accept: "application/atom+xml", "User-Agent": "Spexivix-EDE/0.1" },
      next: { revalidate: 60 * 60 },
    });
    if (!response.ok) {
      return [];
    }

    const parsed = xmlParser.parse(await response.text()) as { feed?: { entry?: unknown[] | unknown } };
    return toArray(parsed.feed?.entry).map((entry) => {
      const item = entry as Record<string, unknown>;
      const links = toArray(item.link) as Array<Record<string, unknown>>;
      const pdfUrl = links.find((link) => String(link.title ?? "").toLowerCase() === "pdf")?.href;
      const arxivId = String(item.id ?? "").split("/abs/")[1] ?? null;
      return {
        id: arxivId || clean(String(item.title ?? "")),
        provider: "arXiv",
        providerPaperId: arxivId,
        title: clean(String(item.title ?? "")),
        authors: toArray(item.author).map((author) => clean(String((author as Record<string, unknown>).name ?? ""))).filter(Boolean),
        journal: "arXiv",
        year: Number(String(item.published ?? "").slice(0, 4)) || new Date().getFullYear(),
        doi: null,
        pmid: null,
        pmcid: null,
        arxivId,
        sourceUrl: String(item.id ?? ""),
        pdfUrl: pdfUrl ? String(pdfUrl) : null,
        isOpenAccess: true,
        hasFullText: Boolean(pdfUrl),
        abstractText: clean(String(item.summary ?? "")),
        metadata: { provider: "arXiv" },
      } satisfies SourcePaper;
    }).filter((paper) => paper.title);
  } catch {
    return [];
  }
}

async function acquireReadablePapers(papers: SourcePaper[]) {
  const enriched: Array<{ paper: SourcePaper; sections: ParsedSection[] }> = [];

  for (const paper of papers) {
    const sections = paper.pmcid ? await getPmcFullTextSections(paper.pmcid) : [];
    if (sections.length) {
      enriched.push({ paper: { ...paper, hasFullText: true, isOpenAccess: true }, sections });
      continue;
    }

    if (paper.abstractText) {
      enriched.push({ paper, sections: abstractToSections(paper.abstractText) });
    }
  }

  return enriched;
}

async function getPmcFullTextSections(pmcid: string): Promise<ParsedSection[]> {
  const articles = await fetchPmcXml([pmcid.replace(/^PMC/i, "")]);
  const article = articles[0];
  if (!article) {
    return [];
  }

  const value = article as Record<string, unknown>;
  const body = value.body as Record<string, unknown> | undefined;
  return parseBodySections(body);
}

async function fetchPmcXml(ids: string[]) {
  const params = new URLSearchParams({ db: "pmc", id: ids.join(","), retmode: "xml" });
  const response = await fetch(`${NCBI_BASE_URL}/efetch.fcgi?${params}`, {
    headers: { Accept: "application/xml", "User-Agent": "Spexivix-EDE/0.1" },
    next: { revalidate: 60 * 60 },
  });
  if (!response.ok) {
    return [];
  }

  const parsed = xmlParser.parse(await response.text()) as Record<string, unknown>;
  const root = (parsed["pmc-articleset"] ?? parsed.PmcArticleset ?? parsed) as Record<string, unknown>;
  return toArray(root.article);
}

async function indexPapers(readablePapers: Array<{ paper: SourcePaper; sections: ParsedSection[] }>) {
  const journalIds: string[] = [];
  const chunkIds: string[] = [];

  for (const { paper, sections } of readablePapers) {
    const journalId = stableJournalId(paper);
    journalIds.push(journalId);
    await upsertPaper(paper, journalId);

    for (const source of paperSourcesForPaper(paper, journalId)) {
      await db.insert(paperSources).values(source).onConflictDoNothing();
    }

    for (const section of sections) {
      const sectionId = stableId("section", `${journalId}:${section.name}:${section.type}`);
      const sectionContent = section.paragraphs.map((paragraph) => paragraph.text).join("\n\n");
      await db
        .insert(journalSections)
        .values({
          id: sectionId,
          journalId,
          heading: section.name,
          sectionType: section.type,
          extractionSource: section.source,
          content: sectionContent,
          tags: expandScientificTerms(sectionContent).slice(0, 8),
        })
        .onConflictDoUpdate({
          target: journalSections.id,
          set: {
            heading: section.name,
            sectionType: section.type,
            extractionSource: section.source,
            content: sectionContent,
          },
        });

      for (const paragraph of section.paragraphs) {
        const paragraphId = stableId("paragraph", `${sectionId}:${paragraph.position}:${paragraph.text.slice(0, 180)}`);
        await db
          .insert(paperParagraphs)
          .values({
            id: paragraphId,
            journalId,
            sectionId,
            sectionName: section.name,
            subsection: section.subsection,
            position: paragraph.position,
            pageNumber: paragraph.pageNumber,
            content: paragraph.text,
            sourceUrl: paper.sourceUrl,
          })
          .onConflictDoUpdate({
            target: paperParagraphs.id,
            set: { content: paragraph.text, pageNumber: paragraph.pageNumber, sourceUrl: paper.sourceUrl },
          });

        const chunks = chunkParagraph(paragraph.text);
        const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));

        for (const [index, chunk] of chunks.entries()) {
          const chunkId = stableId("chunk", `${paragraphId}:${index}:${chunk.text.slice(0, 180)}`);
          chunkIds.push(chunkId);
          await db
            .insert(evidenceChunks)
            .values({
              id: chunkId,
              journalId,
              sectionId,
              paragraphId,
              sectionName: section.name,
              subsection: section.subsection,
              paragraphPosition: paragraph.position,
              pageNumber: paragraph.pageNumber,
              chunkIndex: index,
              rawText: chunk.text,
              tokenCount: chunk.tokenCount,
              embedding: embeddings[index].embedding,
              embeddingModel: embeddings[index].model,
              extractionSource: section.source,
              sourceUrl: paper.sourceUrl,
            })
            .onConflictDoUpdate({
              target: evidenceChunks.id,
              set: {
                rawText: chunk.text,
                tokenCount: chunk.tokenCount,
                embedding: embeddings[index].embedding,
                embeddingModel: embeddings[index].model,
                extractionSource: section.source,
                sourceUrl: paper.sourceUrl,
              },
            });
        }
      }
    }
  }

  return { journalIds: unique(journalIds), chunkIds: unique(chunkIds) };
}

async function retrieveAndRankEvidence(context: QueryContext, journalIds: string[], chunkIds: string[]): Promise<EvidenceBlock[]> {
  if (!journalIds.length || !chunkIds.length) {
    return [];
  }

  const [{ embedding: queryEmbedding }] = await embedTexts([`${context.translatedQuery} ${context.expandedTerms.join(" ")}`]);
  const vectorLiteral = vectorSql(queryEmbedding);
  const rows = await db
    .select({
      chunkId: evidenceChunks.id,
      journalId: journals.id,
      title: journals.title,
      authors: journals.authors,
      journal: journals.journalName,
      year: journals.publicationYear,
      doi: journals.doi,
      sourceUrl: journals.sourceUrl,
      pdfUrl: journals.pdfUrl,
      section: evidenceChunks.sectionName,
      subsection: evidenceChunks.subsection,
      pageNumber: evidenceChunks.pageNumber,
      paragraphNumber: evidenceChunks.paragraphPosition,
      paragraph: evidenceChunks.rawText,
      extractionSource: evidenceChunks.extractionSource,
      distance: sql<number>`${evidenceChunks.embedding} <=> ${vectorLiteral}`,
    })
    .from(evidenceChunks)
    .innerJoin(journals, eq(evidenceChunks.journalId, journals.id))
    .where(and(inArray(evidenceChunks.id, chunkIds), isNotNull(evidenceChunks.embedding)))
    .orderBy(sql`${evidenceChunks.embedding} <=> ${vectorLiteral}`)
    .limit(40);

  return rows
    .map((row) => {
      const semanticScore = Math.max(0, Math.min(100, (1 - Number(row.distance ?? 1)) * 100));
      const keywordScore = keywordScoreFor(context, row.paragraph);
      const journalQualityScore = row.extractionSource === "full_text" ? 92 : 64;
      const recencyScore = recencyScoreFor(row.year);
      const finalScore = Math.round((semanticScore * 0.6) + (keywordScore * 0.2) + (journalQualityScore * 0.1) + (recencyScore * 0.1));
      const highlightedSpan = exactSupportingSpan(context, row.paragraph);
      const confidenceLabel = confidenceFor(finalScore, highlightedSpan);
      const citation = citationFor({
        title: row.title,
        authors: row.authors,
        year: row.year,
        journal: row.journal,
        doi: row.doi,
        pageNumber: row.pageNumber,
      });

      return {
        resultId: crypto.randomUUID(),
        journalId: row.journalId,
        chunkId: row.chunkId,
        title: row.title,
        authors: row.authors,
        journal: row.journal,
        year: row.year,
        doi: row.doi,
        sourceUrl: row.sourceUrl,
        pdfUrl: row.pdfUrl,
        section: row.section,
        subsection: row.subsection,
        pageNumber: row.pageNumber,
        paragraphNumber: row.paragraphNumber,
        paragraph: row.paragraph,
        highlightedSpan,
        score: finalScore,
        confidenceLabel,
        citation,
        extractionSource: row.extractionSource as ExtractionSource,
      } satisfies EvidenceBlock;
    })
    .filter((block) => block.highlightedSpan.length > 20 || block.score >= 45)
    .sort((a, b) => {
      const priority = confidenceRank(b.confidenceLabel) - confidenceRank(a.confidenceLabel);
      return priority || b.score - a.score;
    })
    .slice(0, RESULT_LIMIT);
}

async function generateGroundedAnswer(context: QueryContext, evidence: EvidenceBlock[]) {
  if (!evidence.length || evidence[0].score < 40) {
    return {
      answer: "No sufficient evidence was found for this query.",
      confidenceLabel: "Insufficient Evidence",
      keyFindings: [],
      conclusion: "No sufficient evidence was found for this query.",
      citations: [],
    };
  }

  const aiAnswer = await answerWithOpenAI(context, evidence);
  if (aiAnswer) {
    return aiAnswer;
  }

  const findings = evidence.slice(0, 3).map((item) => item.highlightedSpan || firstSentence(item.paragraph));
  const citations = evidence.slice(0, 5).map((item) => item.citation);
  const englishAnswer = `Evidence from the retrieved literature indicates: ${findings.join(" ")}`;
  const answer = localizeAnswer(context, englishAnswer);

  return {
    answer,
    confidenceLabel: evidence[0].confidenceLabel,
    keyFindings: findings,
    conclusion: localizeAnswer(context, findings[0] ?? "No sufficient evidence was found for this query."),
    citations,
  };
}

async function answerWithOpenAI(context: QueryContext, evidence: EvidenceBlock[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_SUMMARY_MODEL ?? "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You are Spexivix. Answer only using provided evidence. Never invent citations, DOI, authors, evidence, or scientific claims. Return JSON.",
          },
          {
            role: "user",
            content: JSON.stringify({
              query: context.originalQuery,
              answerLanguage: context.answerLanguage,
              translatedQuery: context.translatedQuery,
              requiredInsufficientAnswer: "No sufficient evidence was found for this query.",
              evidence: evidence.slice(0, 5).map((item, index) => ({
                ref: index + 1,
                text: item.highlightedSpan || item.paragraph,
                citation: item.citation,
              })),
              outputShape: {
                answer: "string",
                keyFindings: ["string"],
                conclusion: "string",
              },
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as {
      answer?: string;
      keyFindings?: string[];
      conclusion?: string;
    };

    if (!parsed.answer) {
      return null;
    }

    return {
      answer: parsed.answer,
      confidenceLabel: evidence[0]?.confidenceLabel ?? "Supporting Evidence",
      keyFindings: parsed.keyFindings?.slice(0, 4) ?? [],
      conclusion: parsed.conclusion ?? parsed.answer,
      citations: evidence.slice(0, 5).map((item) => item.citation),
    };
  } catch {
    return null;
  }
}

async function persistSearch(context: QueryContext, grounded: Awaited<ReturnType<typeof generateGroundedAnswer>>, userId: string, evidence: EvidenceBlock[]) {
  const searchId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(searches).values({
      id: searchId,
      userId,
      query: context.originalQuery,
      detectedLanguage: context.detectedLanguage,
      translatedQuery: context.translatedQuery,
      sourceCount: unique(evidence.map((item) => item.journalId)).length,
      resultCount: evidence.length,
      assistantMetadata: {
        expandedTerms: context.expandedTerms,
        citations: grounded.citations,
      },
      answer: grounded.answer,
      confidenceLabel: grounded.confidenceLabel,
      status: "completed",
    });

    for (const [index, item] of evidence.entries()) {
      await tx.insert(searchResults).values({
        id: item.resultId,
        searchId,
        journalId: item.journalId,
        chunkId: item.chunkId,
        relevanceScore: item.score,
        highlightedText: item.paragraph,
        highlightedSpan: item.highlightedSpan,
        aiSummary: grounded.answer,
        simpleExplanation: grounded.answer,
        scientificSummary: item.highlightedSpan || item.paragraph,
        keyFindings: grounded.keyFindings,
        mainConclusion: grounded.conclusion,
        extractionSource: item.extractionSource,
        pageNumber: item.pageNumber,
        paragraphNumber: item.paragraphNumber,
        subsection: item.subsection,
        confidenceLabel: item.confidenceLabel,
        citation: item.citation,
        metadata: {
          section: item.section,
          doi: item.doi,
          sourceUrl: item.sourceUrl,
        },
        rank: index + 1,
      });
    }
  });

  return searchId;
}

function parsePmcArticle(article: unknown): SourcePaper | null {
  const value = article as Record<string, unknown>;
  const front = value.front as Record<string, unknown> | undefined;
  const articleMeta = front?.["article-meta"] as Record<string, unknown> | undefined;
  const journalMeta = front?.["journal-meta"] as Record<string, unknown> | undefined;
  const doi = articleId(articleMeta?.["article-id"], "doi");
  const pmcid = normalizePmcId(articleId(articleMeta?.["article-id"], "pmc") ?? "");
  const pmid = articleId(articleMeta?.["article-id"], "pmid");
  const title = clean(text((articleMeta?.["title-group"] as Record<string, unknown> | undefined)?.["article-title"]));
  if (!title) {
    return null;
  }

  return {
    id: pmcid ?? doi ?? title,
    provider: "PubMed Central",
    providerPaperId: pmcid,
    title,
    authors: parsePmcAuthors(articleMeta?.["contrib-group"]),
    journal: clean(text((journalMeta?.["journal-title-group"] as Record<string, unknown> | undefined)?.["journal-title"]) || "PubMed Central"),
    year: parsePmcYear(articleMeta?.["pub-date"]),
    doi,
    pmid,
    pmcid,
    arxivId: null,
    sourceUrl: pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` : doi ? `https://doi.org/${doi}` : null,
    pdfUrl: pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/` : null,
    isOpenAccess: true,
    hasFullText: true,
    abstractText: clean(text(articleMeta?.abstract)) || null,
    metadata: { provider: "PubMed Central", pmcid, pmid },
  };
}

function parsePubMedArticle(article: unknown): SourcePaper | null {
  const value = article as Record<string, unknown>;
  const medline = value.MedlineCitation as Record<string, unknown> | undefined;
  const pubmedData = value.PubmedData as Record<string, unknown> | undefined;
  const articleData = medline?.Article as Record<string, unknown> | undefined;
  const journalData = articleData?.Journal as Record<string, unknown> | undefined;
  const pmid = clean(text(medline?.PMID));
  const title = clean(text(articleData?.ArticleTitle));
  const abstractText = clean(text((articleData?.Abstract as Record<string, unknown> | undefined)?.AbstractText));
  if (!pmid || !title || !abstractText) {
    return null;
  }

  const doi = articleId(pubmedData?.ArticleIdList, "doi");
  return {
    id: pmid,
    provider: "PubMed",
    providerPaperId: pmid,
    title,
    authors: parsePubMedAuthors(articleData?.AuthorList),
    journal: clean(text((journalData as Record<string, unknown> | undefined)?.Title) || "PubMed"),
    year: parsePubMedYear(journalData?.JournalIssue),
    doi,
    pmid,
    pmcid: articleId(pubmedData?.ArticleIdList, "pmc"),
    arxivId: null,
    sourceUrl: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    pdfUrl: null,
    isOpenAccess: false,
    hasFullText: false,
    abstractText,
    metadata: { provider: "PubMed", pmid },
  };
}

function parseBodySections(body: unknown): ParsedSection[] {
  const sections = toArray((body as Record<string, unknown> | undefined)?.sec).flatMap((section) => parseSec(section));
  return sections.length ? sections : [];
}

function parseSec(section: unknown, inheritedTitle?: string): ParsedSection[] {
  const value = section as Record<string, unknown>;
  const name = clean(text(value.title) || inheritedTitle || "Full text");
  const type = sectionType(name);
  const paragraphs = toArray(value.p)
    .map((paragraph, index) => ({ text: clean(text(paragraph)), position: index + 1, pageNumber: null }))
    .filter((paragraph) => paragraph.text.length > 80);
  const childSections = toArray(value.sec).flatMap((child) => parseSec(child, name));
  const current = paragraphs.length
    ? [{ name, type, subsection: inheritedTitle ?? null, paragraphs, source: "full_text" as const }]
    : [];

  return [...current, ...childSections].filter((item) =>
    ["introduction", "methods", "results", "discussion", "conclusion", "limitations", "full_text"].includes(item.type),
  );
}

function abstractToSections(abstractText: string): ParsedSection[] {
  return [{
    name: "Abstract",
    type: "abstract",
    subsection: null,
    paragraphs: chunkSentencesToParagraphs(abstractText).map((textValue, index) => ({
      text: textValue,
      position: index + 1,
      pageNumber: null,
    })),
    source: "abstract",
  }];
}

function chunkParagraph(textValue: string) {
  const words = textValue.split(/\s+/).filter(Boolean);
  const target = 500;
  const overlap = 100;
  const chunks: Array<{ text: string; tokenCount: number }> = [];

  if (words.length <= target) {
    return [{ text: textValue, tokenCount: words.length }];
  }

  for (let start = 0; start < words.length; start += target - overlap) {
    const slice = words.slice(start, start + target);
    if (slice.length < 40) {
      break;
    }
    chunks.push({ text: slice.join(" "), tokenCount: slice.length });
  }

  return chunks;
}

async function embedTexts(inputs: string[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-large";
  if (apiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: inputs }),
      });
      if (response.ok) {
        const payload = await response.json() as { data?: Array<{ embedding: number[] }> };
        const embeddings = payload.data?.map((item) => item.embedding);
        if (embeddings?.length === inputs.length && embeddings.every((embedding) => embedding.length === VECTOR_DIMENSIONS)) {
          return embeddings.map((embedding) => ({ embedding, model }));
        }
      }
    } catch {
      // Local fallback below keeps the product usable in development.
    }
  }

  return inputs.map((input) => ({ embedding: localEmbedding(input), model: "local-hashing-3072" }));
}

function localEmbedding(input: string) {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  const tokens = tokenize(input);
  for (const token of tokens) {
    const index = hashNumber(token) % VECTOR_DIMENSIONS;
    vector[index] += 1;
    for (const synonym of scientificSynonyms[token] ?? []) {
      vector[hashNumber(synonym.toLowerCase()) % VECTOR_DIMENSIONS] += 0.6;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

async function translateWithOpenAI(query: string, detectedLanguage: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || detectedLanguage === "English") {
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Translate scientific search intent into concise English. Preserve biomedical abbreviations. Return JSON." },
          { role: "user", content: JSON.stringify({ query, output: { translatedQuery: "English scientific query" } }) },
        ],
      }),
    });
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as { translatedQuery?: string };
    return parsed.translatedQuery ? clean(parsed.translatedQuery) : null;
  } catch {
    return null;
  }
}

function translateLocally(query: string) {
  let translated = query;
  for (const [pattern, replacement] of glossary) {
    translated = translated.replace(pattern, replacement);
  }
  return clean(translated);
}

function detectLanguage(query: string) {
  const lower = query.toLowerCase();
  if (/\b(peran|dalam|inflamasi|paru|makrofag|penyakit)\b/.test(lower)) return "Bahasa Indonesia";
  if (/\b(arabic|دور|التهاب|الرئة)\b/.test(lower)) return "Arabic";
  if (/\b(inflamación|pulmón|papel)\b/.test(lower)) return "Spanish";
  if (/\b(rôle|poumon)\b/.test(lower)) return "French";
  if (/\b(entzündung|lunge)\b/.test(lower)) return "German";
  return /[^\u0000-\u007f]/.test(query) ? "non-English" : "English";
}

function expandScientificTerms(value: string) {
  const terms = new Set<string>();
  for (const token of tokenize(value)) {
    terms.add(token);
    for (const synonym of scientificSynonyms[token] ?? []) {
      terms.add(synonym);
    }
  }
  return [...terms].slice(0, 32);
}

function buildSourceQuery(context: QueryContext) {
  return unique([...context.searchTerms, ...context.expandedTerms.slice(0, 10)]).join(" OR ");
}

function dedupePapers(papers: SourcePaper[]) {
  const seen = new Map<string, SourcePaper>();
  for (const paper of papers.filter((item) => item.title)) {
    const key = paper.doi?.toLowerCase() || paper.pmid || paper.arxivId || stableId("title", paper.title.toLowerCase());
    const existing = seen.get(key);
    if (!existing || sourcePriority(paper) > sourcePriority(existing)) {
      seen.set(key, paper);
    }
  }
  return [...seen.values()].sort((a, b) => sourcePriority(b) - sourcePriority(a));
}

function sourcePriority(paper: SourcePaper) {
  if (paper.provider === "Europe PMC" && paper.hasFullText) return 5;
  if (paper.provider === "PubMed Central" && paper.hasFullText) return 4;
  if (paper.pdfUrl && paper.isOpenAccess) return 3;
  if (paper.provider === "OpenAlex" && paper.hasFullText) return 2;
  if (paper.abstractText) return 1;
  return 0;
}

async function upsertPaper(paper: SourcePaper, journalId: string) {
  await db
    .insert(journals)
    .values({
      id: journalId,
      title: paper.title,
      authors: paper.authors,
      journalName: paper.journal,
      publicationYear: paper.year || new Date().getFullYear(),
      doi: paper.doi,
      sourceUrl: paper.sourceUrl,
      pdfUrl: paper.pdfUrl,
      metadata: paper.metadata,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: journals.id,
      set: {
        title: paper.title,
        authors: paper.authors,
        journalName: paper.journal,
        publicationYear: paper.year || new Date().getFullYear(),
        doi: paper.doi,
        sourceUrl: paper.sourceUrl,
        pdfUrl: paper.pdfUrl,
        metadata: paper.metadata,
        updatedAt: new Date(),
      },
    });
}

function paperSourcesForPaper(paper: SourcePaper, journalId: string) {
  return [{
    id: stableId("source", `${journalId}:${paper.provider}:${paper.providerPaperId ?? paper.doi ?? paper.title}`),
    journalId,
    provider: paper.provider,
    providerPaperId: paper.providerPaperId,
    doi: paper.doi,
    pmid: paper.pmid,
    pmcid: paper.pmcid,
    arxivId: paper.arxivId,
    sourceUrl: paper.sourceUrl,
    pdfUrl: paper.pdfUrl,
    isOpenAccess: paper.isOpenAccess,
    hasFullText: paper.hasFullText,
    metadata: paper.metadata,
  }];
}

function crossrefItemToPaper(item: Record<string, unknown>): SourcePaper | null {
  const title = clean(String(toArray(item.title)[0] ?? ""));
  if (!title) return null;
  const dateParts = (item.published as Record<string, unknown> | undefined)?.["date-parts"] as number[][] | undefined;
  return {
    id: String(item.DOI ?? title),
    provider: "CrossRef",
    providerPaperId: item.DOI ? String(item.DOI) : null,
    title,
    authors: toArray(item.author).map((author) => {
      const value = author as Record<string, unknown>;
      return clean([value.given, value.family].filter(Boolean).join(" "));
    }).filter(Boolean),
    journal: clean(String(toArray(item["container-title"])[0] ?? "CrossRef")),
    year: dateParts?.[0]?.[0] ?? new Date().getFullYear(),
    doi: item.DOI ? clean(String(item.DOI)) : null,
    pmid: null,
    pmcid: null,
    arxivId: null,
    sourceUrl: item.URL ? String(item.URL) : null,
    pdfUrl: null,
    isOpenAccess: false,
    hasFullText: false,
    abstractText: item.abstract ? clean(text(item.abstract)) : null,
    metadata: { provider: "CrossRef" },
  };
}

function keywordScoreFor(context: QueryContext, value: string) {
  const lower = value.toLowerCase();
  const terms = unique([...tokenize(context.translatedQuery), ...context.expandedTerms.map((term) => term.toLowerCase())]);
  const matches = terms.filter((term) => lower.includes(term.toLowerCase())).length;
  return Math.min(100, Math.round((matches / Math.max(1, Math.min(terms.length, 12))) * 100));
}

function recencyScoreFor(year: number) {
  const age = Math.max(0, new Date().getFullYear() - year);
  return Math.max(30, 100 - age * 4);
}

function exactSupportingSpan(context: QueryContext, paragraph: string) {
  const sentences = paragraph.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
  const ranked = sentences
    .map((sentence) => ({ sentence, score: keywordScoreFor(context, sentence) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0].sentence : firstSentence(paragraph);
}

function confidenceFor(score: number, span: string): EvidenceBlock["confidenceLabel"] {
  if (score >= 78 && span.length > 30) return "Direct Evidence";
  if (score >= 62) return "Strong Evidence";
  return "Supporting Evidence";
}

function confidenceRank(label: EvidenceBlock["confidenceLabel"]) {
  return label === "Direct Evidence" ? 3 : label === "Strong Evidence" ? 2 : 1;
}

function citationFor(input: { authors: string[]; year: number; title: string; journal: string; doi: string | null; pageNumber: number | null }) {
  const leadAuthor = input.authors[0]?.split(" ").slice(-1)[0] ?? "Unknown author";
  const authorText = input.authors.length > 1 ? `${leadAuthor} et al.` : leadAuthor;
  const doiText = input.doi ? ` DOI: ${input.doi}.` : "";
  const pageText = input.pageNumber ? ` Page ${input.pageNumber}.` : "";
  return `${authorText} (${input.year}). ${input.title}. ${input.journal}.${doiText}${pageText}`;
}

function localizeAnswer(context: QueryContext, english: string) {
  if (context.detectedLanguage === "Bahasa Indonesia") {
    return `Berdasarkan bukti yang ditemukan: ${english.replace(/^Evidence from the retrieved literature indicates:\s*/i, "")}`;
  }
  return english;
}

function vectorSql(vector: number[]) {
  const literal = `[${vector.map((value) => Number(value).toFixed(6)).join(",")}]`;
  return sql.raw(`'${literal}'::vector`);
}

function sectionType(name: string) {
  const lower = name.toLowerCase();
  if (/intro|background/.test(lower)) return "introduction";
  if (/method|material|protocol/.test(lower)) return "methods";
  if (/result|finding/.test(lower)) return "results";
  if (/discussion/.test(lower)) return "discussion";
  if (/conclusion|summary/.test(lower)) return "conclusion";
  if (/limitation/.test(lower)) return "limitations";
  if (/reference/.test(lower)) return "references";
  return "full_text";
}

function chunkSentencesToParagraphs(value: string) {
  const sentences = value.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.split(/\s+/).length > 180 && current) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.length ? paragraphs : [value];
}

function articleId(value: unknown, typeName: string) {
  for (const item of toArray((value as Record<string, unknown> | undefined)?.ArticleId ?? value)) {
    const record = item as Record<string, unknown>;
    const typeValue = String(record["pub-id-type"] ?? record.IdType ?? "").toLowerCase();
    if (typeValue === typeName) {
      return clean(text(record["#text"]));
    }
  }
  return null;
}

function parsePmcAuthors(value: unknown) {
  return toArray(value).flatMap((group) => toArray((group as Record<string, unknown>).contrib)).map((contrib) => {
    const name = (contrib as Record<string, unknown>).name as Record<string, unknown> | undefined;
    return clean([text(name?.["given-names"]), text(name?.surname)].filter(Boolean).join(" "));
  }).filter(Boolean).slice(0, 8);
}

function parsePubMedAuthors(value: unknown) {
  return toArray((value as Record<string, unknown> | undefined)?.Author).map((author) => {
    const record = author as Record<string, unknown>;
    return clean(String(record.CollectiveName ?? [record.ForeName, record.LastName].filter(Boolean).join(" ")));
  }).filter(Boolean).slice(0, 8);
}

function parsePmcYear(value: unknown) {
  for (const date of toArray(value)) {
    const year = Number((date as Record<string, unknown>).year);
    if (Number.isFinite(year)) return year;
  }
  return new Date().getFullYear();
}

function parsePubMedYear(value: unknown) {
  const date = ((value as Record<string, unknown> | undefined)?.PubDate ?? {}) as Record<string, unknown>;
  const year = Number(date.Year);
  if (Number.isFinite(year)) return year;
  const match = String(date.MedlineDate ?? "").match(/\d{4}/);
  return match ? Number(match[0]) : new Date().getFullYear();
}

function parseAuthorString(value: string) {
  return value.split(";").map((author) => clean(author)).filter(Boolean).slice(0, 8);
}

function stableJournalId(paper: SourcePaper) {
  if (paper.doi) return stableId("doi", paper.doi.toLowerCase());
  if (paper.pmid) return `pubmed_${paper.pmid}`;
  if (paper.pmcid) return `pmc_${paper.pmcid}`;
  if (paper.arxivId) return `arxiv_${paper.arxivId.replace(/[^a-z0-9]+/gi, "_")}`;
  return stableId("paper", paper.title.toLowerCase());
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${hashNumber(value).toString(36)}`;
}

function hashNumber(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

function normalizePmcId(value: string | null) {
  if (!value) return null;
  return value.toUpperCase().startsWith("PMC") ? value.toUpperCase() : `PMC${value}`;
}

function firstSentence(value: string) {
  return value.split(/(?<=[.!?])\s+/)[0]?.trim() || value.slice(0, 240);
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.entries(record)
      .filter(([key]) => !["IdType", "pub-id-type", "id", "rid", "ref-type"].includes(key))
      .map(([, nested]) => text(nested))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function clean(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&amp;/g, "&").trim();
}

function tokenize(value: string) {
  return clean(value).toLowerCase().replace(/[^a-z0-9-]+/g, " ").split(/\s+/).filter((token) => token.length > 1);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))];
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
