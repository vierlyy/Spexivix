import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => ({
    userIdIdx: index("session_user_id_idx").on(table.userId),
  }),
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("account_user_id_idx").on(table.userId),
  }),
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const searches = pgTable(
  "searches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    query: text("query").notNull(),
    detectedLanguage: text("detected_language").notNull().default("en"),
    translatedQuery: text("translated_query"),
    sourceCount: integer("source_count").notNull().default(0),
    resultCount: integer("result_count").notNull().default(0),
    assistantMetadata: jsonb("assistant_metadata").$type<Record<string, unknown>>().notNull().default({}),
    answer: text("answer"),
    confidenceLabel: text("confidence_label"),
    status: text("status").notNull().default("completed"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("searches_user_id_idx").on(table.userId),
    createdAtIdx: index("searches_created_at_idx").on(table.createdAt),
  }),
);

export const searchJobs = pgTable(
  "search_jobs",
  {
    id: text("id").primaryKey(),
    searchId: text("search_id").references(() => searches.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    detectedLanguage: text("detected_language").notNull().default("English"),
    translatedQuery: text("translated_query"),
    expandedTerms: text("expanded_terms").array().notNull().default([]),
    status: text("status").notNull().default("queued"),
    currentStep: text("current_step").notNull().default("Searching literature..."),
    progress: integer("progress").notNull().default(0),
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    userIdIdx: index("search_jobs_user_id_idx").on(table.userId),
    statusIdx: index("search_jobs_status_idx").on(table.status),
    createdAtIdx: index("search_jobs_created_at_idx").on(table.createdAt),
  }),
);

export const journals = pgTable(
  "journals",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    authors: text("authors").array().notNull().default([]),
    journalName: text("journal_name").notNull(),
    publicationYear: integer("publication_year").notNull(),
    doi: text("doi"),
    sourceUrl: text("source_url"),
    pdfUrl: text("pdf_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    doiIdx: uniqueIndex("journals_doi_idx").on(table.doi),
  }),
);

export const paperSources = pgTable(
  "paper_sources",
  {
    id: text("id").primaryKey(),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerPaperId: text("provider_paper_id"),
    doi: text("doi"),
    pmid: text("pmid"),
    pmcid: text("pmcid"),
    arxivId: text("arxiv_id"),
    sourceUrl: text("source_url"),
    pdfUrl: text("pdf_url"),
    isOpenAccess: boolean("is_open_access").notNull().default(false),
    hasFullText: boolean("has_full_text").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    journalIdIdx: index("paper_sources_journal_id_idx").on(table.journalId),
    providerIdx: index("paper_sources_provider_idx").on(table.provider),
  }),
);

export const journalSections = pgTable(
  "journal_sections",
  {
    id: text("id").primaryKey(),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    heading: text("heading").notNull(),
    sectionType: text("section_type").notNull().default("abstract"),
    extractionSource: text("extraction_source").notNull().default("abstract"),
    content: text("content").notNull(),
    summary: text("summary"),
    tags: text("tags").array().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    journalIdIdx: index("journal_sections_journal_id_idx").on(table.journalId),
  }),
);

export const paperParagraphs = pgTable(
  "paper_paragraphs",
  {
    id: text("id").primaryKey(),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    sectionId: text("section_id").references(() => journalSections.id, { onDelete: "cascade" }),
    sectionName: text("section_name").notNull(),
    subsection: text("subsection"),
    position: integer("position").notNull().default(0),
    pageNumber: integer("page_number"),
    content: text("content").notNull(),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    journalIdIdx: index("paper_paragraphs_journal_id_idx").on(table.journalId),
    sectionIdIdx: index("paper_paragraphs_section_id_idx").on(table.sectionId),
  }),
);

export const evidenceChunks = pgTable(
  "evidence_chunks",
  {
    id: text("id").primaryKey(),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    sectionId: text("section_id").references(() => journalSections.id, { onDelete: "cascade" }),
    paragraphId: text("paragraph_id").references(() => paperParagraphs.id, { onDelete: "cascade" }),
    sectionName: text("section_name").notNull(),
    subsection: text("subsection"),
    paragraphPosition: integer("paragraph_position").notNull().default(0),
    pageNumber: integer("page_number"),
    chunkIndex: integer("chunk_index").notNull().default(0),
    rawText: text("raw_text").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    embedding: vector("embedding", { dimensions: 3072 }),
    embeddingModel: text("embedding_model").notNull().default("local-hashing-3072"),
    extractionSource: text("extraction_source").notNull().default("abstract"),
    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    journalIdIdx: index("evidence_chunks_journal_id_idx").on(table.journalId),
    paragraphIdIdx: index("evidence_chunks_paragraph_id_idx").on(table.paragraphId),
  }),
);

export const searchResults = pgTable(
  "search_results",
  {
    id: text("id").primaryKey(),
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    sectionId: text("section_id").references(() => journalSections.id, { onDelete: "set null" }),
    relevanceScore: real("relevance_score").notNull(),
    highlightedText: text("highlighted_text").notNull(),
    aiSummary: text("ai_summary").notNull(),
    simpleExplanation: text("simple_explanation").notNull().default(""),
    scientificSummary: text("scientific_summary").notNull().default(""),
    keyFindings: text("key_findings").array().notNull().default([]),
    mainConclusion: text("main_conclusion").notNull().default(""),
    extractionSource: text("extraction_source").notNull().default("abstract"),
    paragraphId: text("paragraph_id").references(() => paperParagraphs.id, { onDelete: "set null" }),
    chunkId: text("chunk_id").references(() => evidenceChunks.id, { onDelete: "set null" }),
    pageNumber: integer("page_number"),
    paragraphNumber: integer("paragraph_number"),
    subsection: text("subsection"),
    highlightedSpan: text("highlighted_span"),
    confidenceLabel: text("confidence_label").notNull().default("Supporting Evidence"),
    citation: text("citation"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    rank: integer("rank").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    searchIdIdx: index("search_results_search_id_idx").on(table.searchId),
    journalIdIdx: index("search_results_journal_id_idx").on(table.journalId),
  }),
);

export const collections = pgTable(
  "collections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("collections_user_id_idx").on(table.userId),
  }),
);

export const savedJournals = pgTable(
  "saved_journals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    collectionId: text("collection_id").references(() => collections.id, { onDelete: "set null" }),
    note: text("note"),
    citationStyle: text("citation_style").notNull().default("APA"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("saved_journals_user_id_idx").on(table.userId),
    journalIdIdx: index("saved_journals_journal_id_idx").on(table.journalId),
  }),
);

export const savedEvidence = pgTable(
  "saved_evidence",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    searchResultId: text("search_result_id").references(() => searchResults.id, { onDelete: "cascade" }),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id, { onDelete: "cascade" }),
    collectionId: text("collection_id").references(() => collections.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("saved_evidence_user_id_idx").on(table.userId),
    journalIdIdx: index("saved_evidence_journal_id_idx").on(table.journalId),
  }),
);

export const schema = {
  user,
  session,
  account,
  verification,
  searches,
  searchJobs,
  journals,
  paperSources,
  journalSections,
  paperParagraphs,
  evidenceChunks,
  searchResults,
  collections,
  savedJournals,
  savedEvidence,
};
