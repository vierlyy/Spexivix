CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "answer" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "confidence_label" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
CREATE TABLE "search_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"search_id" text,
	"user_id" text,
	"query" text NOT NULL,
	"detected_language" text DEFAULT 'English' NOT NULL,
	"translated_query" text,
	"expanded_terms" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"current_step" text DEFAULT 'Searching literature...' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);--> statement-breakpoint
CREATE TABLE "paper_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_paper_id" text,
	"doi" text,
	"pmid" text,
	"pmcid" text,
	"arxiv_id" text,
	"source_url" text,
	"pdf_url" text,
	"is_open_access" boolean DEFAULT false NOT NULL,
	"has_full_text" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "paper_paragraphs" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_id" text NOT NULL,
	"section_id" text,
	"section_name" text NOT NULL,
	"subsection" text,
	"position" integer DEFAULT 0 NOT NULL,
	"page_number" integer,
	"content" text NOT NULL,
	"source_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "evidence_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_id" text NOT NULL,
	"section_id" text,
	"paragraph_id" text,
	"section_name" text NOT NULL,
	"subsection" text,
	"paragraph_position" integer DEFAULT 0 NOT NULL,
	"page_number" integer,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"raw_text" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(3072),
	"embedding_model" text DEFAULT 'local-hashing-3072' NOT NULL,
	"extraction_source" text DEFAULT 'abstract' NOT NULL,
	"source_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "paragraph_id" text;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "chunk_id" text;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "page_number" integer;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "paragraph_number" integer;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "subsection" text;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "highlighted_span" text;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "confidence_label" text DEFAULT 'Supporting Evidence' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "citation" text;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "saved_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"search_result_id" text,
	"journal_id" text NOT NULL,
	"collection_id" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_sources" ADD CONSTRAINT "paper_sources_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_paragraphs" ADD CONSTRAINT "paper_paragraphs_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_paragraphs" ADD CONSTRAINT "paper_paragraphs_section_id_journal_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."journal_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_section_id_journal_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."journal_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_paragraph_id_paper_paragraphs_id_fk" FOREIGN KEY ("paragraph_id") REFERENCES "public"."paper_paragraphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_paragraph_id_paper_paragraphs_id_fk" FOREIGN KEY ("paragraph_id") REFERENCES "public"."paper_paragraphs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_chunk_id_evidence_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."evidence_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_evidence" ADD CONSTRAINT "saved_evidence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_evidence" ADD CONSTRAINT "saved_evidence_search_result_id_search_results_id_fk" FOREIGN KEY ("search_result_id") REFERENCES "public"."search_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_evidence" ADD CONSTRAINT "saved_evidence_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_evidence" ADD CONSTRAINT "saved_evidence_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_jobs_user_id_idx" ON "search_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "search_jobs_status_idx" ON "search_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "search_jobs_created_at_idx" ON "search_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "paper_sources_journal_id_idx" ON "paper_sources" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "paper_sources_provider_idx" ON "paper_sources" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "paper_paragraphs_journal_id_idx" ON "paper_paragraphs" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "paper_paragraphs_section_id_idx" ON "paper_paragraphs" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "evidence_chunks_journal_id_idx" ON "evidence_chunks" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "evidence_chunks_paragraph_id_idx" ON "evidence_chunks" USING btree ("paragraph_id");--> statement-breakpoint
CREATE INDEX "evidence_chunks_embedding_idx" ON "evidence_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "saved_evidence_user_id_idx" ON "saved_evidence" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "saved_evidence_journal_id_idx" ON "saved_evidence" USING btree ("journal_id");
