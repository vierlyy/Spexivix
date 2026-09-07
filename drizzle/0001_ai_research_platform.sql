ALTER TABLE "searches" ADD COLUMN "detected_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "translated_query" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "assistant_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_sections" ADD COLUMN "section_type" text DEFAULT 'abstract' NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_sections" ADD COLUMN "extraction_source" text DEFAULT 'abstract' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "simple_explanation" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "scientific_summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "key_findings" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "main_conclusion" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_results" ADD COLUMN "extraction_source" text DEFAULT 'abstract' NOT NULL;
