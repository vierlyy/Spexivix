"use client";

import {
  ArrowUpRight,
  Bookmark,
  BookMarked,
  BookOpenCheck,
  Brain,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  FileText,
  FileSearch,
  FolderOpen,
  Highlighter,
  Languages,
  Link2,
  ListChecks,
  Loader2,
  Microscope,
  Moon,
  Network,
  PanelLeft,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  UserRound,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { ElementType, FormEvent } from "react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  createEvidenceSearch,
  getBookmarks,
  getCollections,
  getEvidenceSearchJob,
  getSearchHistory,
  saveBookmark,
  type BookmarkItem,
  type CollectionItem,
  type EvidenceBlock,
  type SearchHistoryItem,
  type SearchResult,
  type SearchResponse,
} from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";

const loadingSteps = [
  "Searching literature...",
  "Finding relevant papers...",
  "Reading papers...",
  "Extracting evidence...",
  "Ranking evidence...",
  "Generating answer...",
];

const pipeline = [
  "Language detection",
  "Full-text retrieval",
  "Semantic chunk ranking",
  "Evidence extraction",
  "Research assistant",
];

export default function Home() {
  const session = authClient.useSession();
  const user = session.data?.user;
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [evidenceSearch, setEvidenceSearch] = useState<SearchResponse | null>(null);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchStep, setSearchStep] = useState(loadingSteps[0]);
  const [searchProgress, setSearchProgress] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
  }, [isDarkMode]);

  useEffect(() => {
    async function loadApiData() {
      if (session.isPending || !user?.id) {
        setSearchHistory([]);
        setBookmarks([]);
        setCollections([]);
        return;
      }

      try {
        const [{ history }, { collections: apiCollections }] = await Promise.all([
          getSearchHistory(),
          getCollections(),
        ]);
        setSearchHistory(history);
        setCollections(apiCollections);
      } catch (error) {
        console.warn("Workspace data failed to load.", error);
        setSearchHistory([]);
        setCollections([]);
      }

      try {
        const { bookmarks: apiBookmarks } = await getBookmarks();
        setBookmarks(apiBookmarks);
      } catch {
        setBookmarks([]);
      }
    }

    loadApiData();
  }, [session.isPending, user?.id]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return;
    }
    if (!user?.id) {
      setSearchError("Sign in to search journals.");
      return;
    }

    setQuery(trimmedQuery);
    setIsSearching(true);
    setSearchStep(loadingSteps[0]);
    setSearchProgress(5);
    setSearchError(null);
    setEvidenceSearch(null);
    setSearchResults([]);

    try {
      const job = await createEvidenceSearch(trimmedQuery);
      setSearchStep(job.currentStep);
      setSearchProgress(job.progress);

      const response = await pollEvidenceJob(job.jobId);
      setEvidenceSearch(response);
      setSelectedSources(response.sources);
      setSearchResults((response.evidence ?? []).map(evidenceToSearchResult));
      setSubmittedQuery(trimmedQuery);

      const { history } = await getSearchHistory();
      setSearchHistory(history);
    } catch (error) {
      setSearchResults([]);
      setSearchError(error instanceof Error ? error.message : "Search failed.");
    } finally {
      setIsSearching(false);
    }
  }

  async function pollEvidenceJob(jobId: string): Promise<SearchResponse> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 1000 * 180) {
      const job = await getEvidenceSearchJob(jobId);
      setSearchStep(job.currentStep);
      setSearchProgress(job.progress);

      if (job.status === "completed" && job.result) {
        return job.result;
      }

      if (job.status === "failed") {
        throw new Error(job.error ?? "Evidence search failed.");
      }

      await new Promise((resolve) => setTimeout(resolve, 1250));
    }

    throw new Error("Evidence search is taking longer than expected. Please try again.");
  }

  async function handleSaveJournal(journalId: string) {
    setSearchError(null);

    try {
      await saveBookmark(journalId);
      const { bookmarks: apiBookmarks } = await getBookmarks();
      setBookmarks(apiBookmarks);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Unable to save journal.");
    }
  }

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthMessage(null);
    setIsAuthSubmitting(true);

    try {
      const result =
        authMode === "sign-up"
          ? await authClient.signUp.email({
              name: authName.trim() || authEmail.split("@")[0],
              email: authEmail,
              password: authPassword,
            })
          : await authClient.signIn.email({
              email: authEmail,
              password: authPassword,
            });

      if (result.error) {
        setAuthMessage(result.error.message ?? "Authentication failed.");
        return;
      }

      setAuthMessage(authMode === "sign-up" ? "Account created." : "Signed in.");
      setAuthPassword("");
      await session.refetch();
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleSignOut() {
    await authClient.signOut();
    await session.refetch();
    setBookmarks([]);
  }

  const suggestedSearches = searchHistory.map((item) => item.query).slice(0, 4);

  if (session.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="rounded-lg border border-white/60 bg-white/75 p-6 text-sm text-muted-foreground shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
          Loading Spexivix...
        </div>
      </main>
    );
  }

  if (!user?.id) {
    return (
      <main className="min-h-screen overflow-hidden px-4 py-4 sm:px-6 lg:px-8">
        <SearchLoadingOverlay progress={searchProgress} step={searchStep} visible={isSearching} />
        <AppNav
          isAuthPending={false}
          isDarkMode={isDarkMode}
          onSignOut={handleSignOut}
          onToggleTheme={() => setIsDarkMode((value) => !value)}
        />
        <section className="mx-auto flex min-h-[calc(100vh-6.5rem)] max-w-md items-center justify-center py-8">
          <AccountPanel
            authEmail={authEmail}
            authMessage={authMessage}
            authMode={authMode}
            authName={authName}
            authPassword={authPassword}
            isSubmitting={isAuthSubmitting}
            onAuthEmailChange={setAuthEmail}
            onAuthModeChange={setAuthMode}
            onAuthNameChange={setAuthName}
            onAuthPasswordChange={setAuthPassword}
            onSignOut={handleSignOut}
            onSubmit={handleAuthSubmit}
          />
        </section>
      </main>
    );
  }

  if (!submittedQuery) {
    return (
      <main className="min-h-screen overflow-hidden px-4 py-4 sm:px-6 lg:px-8">
        <SearchLoadingOverlay progress={searchProgress} step={searchStep} visible={isSearching} />
        <AppNav
          isAuthPending={session.isPending}
          isDarkMode={isDarkMode}
          userEmail={user?.email}
          userImage={user?.image ?? undefined}
          userName={user?.name}
          onSignOut={handleSignOut}
          onToggleTheme={() => setIsDarkMode((value) => !value)}
        />

        <section className="mx-auto grid min-h-[calc(100vh-6.5rem)] w-full max-w-7xl items-center gap-6 py-8 lg:grid-cols-[260px_minmax(0,1fr)]">
          <motion.aside
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.45 }}
            className="hidden lg:block"
          >
            <ResearchSidebar history={searchHistory} onSelectSearch={setQuery} />
          </motion.aside>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="mx-auto w-full max-w-2xl text-center"
          >
            <div className="mx-auto mb-6 flex size-12 items-center justify-center rounded-md border border-white/50 bg-white/65 text-primary shadow-sm backdrop-blur-2xl dark:border-white/10 dark:bg-white/10 dark:text-cyan-200">
              <Microscope className="size-6" />
            </div>
            <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-primary dark:text-cyan-200">
              Spexivix AI research engine
            </p>
            <h1 className="mx-auto max-w-xl text-2xl font-semibold tracking-normal text-foreground sm:text-4xl">
              What journal do you want to search for today?
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
              Search across scientific literature with source-aware summaries, section-level matches, and saved research trails.
            </p>

            <form
              onSubmit={handleSubmit}
              className="mx-auto mt-6 flex max-w-xl flex-col gap-2 rounded-lg border border-white/60 bg-white/70 p-1.5 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55 sm:flex-row"
            >
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-12 border-transparent bg-white/70 pl-10 text-sm shadow-none dark:bg-white/10"
                  placeholder="Role of NOX in lung inflammation"
                  aria-label="Journal search query"
                />
              </div>
              <Button type="submit" size="lg" className="h-12 sm:w-32" disabled={isSearching}>
                <Sparkles />
                {isSearching ? "Searching" : "Search"}
              </Button>
            </form>

            <SuggestedSearchPills suggestions={suggestedSearches} onSelectSearch={setQuery} />
            {searchError ? (
              <p className="mt-4 text-sm text-rose-600 dark:text-rose-300">{searchError}</p>
            ) : null}
          </motion.div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-hidden px-4 py-4 sm:px-6 lg:px-8">
      <SearchLoadingOverlay progress={searchProgress} step={searchStep} visible={isSearching} />
      <AppNav
        isAuthPending={session.isPending}
        isDarkMode={isDarkMode}
        userEmail={user?.email}
        userImage={user?.image ?? undefined}
        userName={user?.name}
        onSignOut={handleSignOut}
        onToggleTheme={() => setIsDarkMode((value) => !value)}
      />

      <section className="mx-auto grid max-w-7xl gap-6 py-6 lg:grid-cols-[260px_minmax(0,1fr)_310px]">
        <motion.aside
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4 }}
          className="hidden lg:block"
        >
          <ResearchSidebar history={searchHistory} onSelectSearch={(value) => setQuery(value)} />
        </motion.aside>

        <div className="space-y-6">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="rounded-lg border border-white/60 bg-white/75 p-4 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55 sm:p-6"
          >
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-normal sm:text-2xl">
                  Search inside scientific papers
                </h1>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  Ask a natural-language research question and scan the exact sections, summaries, and source links that matter.
                </p>
              </div>
              <Badge variant="success" className="gap-1.5 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200">
                <ShieldCheck className="size-3.5" />
                MVP preview
              </Badge>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-3 md:flex-row">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-12 pl-10 text-sm"
                  aria-label="Scientific search query"
                />
              </div>
              <Button type="submit" size="lg" className="h-12 md:w-36" disabled={isSearching}>
                <Sparkles />
                {isSearching ? "Searching" : "Search"}
              </Button>
            </form>

            <SuggestedSearchPills suggestions={suggestedSearches} onSelectSearch={setQuery} />
            {searchError ? (
              <p className="mt-4 text-sm text-rose-600 dark:text-rose-300">{searchError}</p>
            ) : null}
          </motion.div>

          <div className="grid gap-4 md:grid-cols-3">
            <Metric icon={Languages} label="Detected language" value={evidenceSearch?.detectedLanguage ?? "English"} />
            <Metric icon={Highlighter} label="Evidence blocks" value={String(evidenceSearch?.evidence?.length ?? searchResults.length)} />
            <Metric icon={Bookmark} label="Saved journals" value={String(bookmarks.length)} />
          </div>

          {evidenceSearch ? (
            <EvidenceSummaryPanel
              result={evidenceSearch}
              onJumpToEvidence={(index) => {
                document.getElementById(`evidence-${index + 1}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          ) : null}

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold tracking-normal">Supporting evidence</h2>
                <p className="text-sm text-muted-foreground">Ranked evidence blocks with exact source locations and grounded citations.</p>
              </div>
              <Button variant="outline" size="sm">
                Relevance
                <ChevronDown />
              </Button>
            </div>

            <AnimatePresence>
              {searchResults.length ? searchResults.map((result, index) => (
              <motion.div
                id={`evidence-${index + 1}`}
                key={`${result.id}-${index}`}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: index * 0.06 }}
              >
              <Card className="overflow-hidden border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_22px_70px_rgba(15,23,42,0.12)] dark:border-white/10 dark:bg-slate-950/55">
                <CardHeader className="gap-3 border-b bg-white/60 dark:bg-white/5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="max-w-2xl">
                      <CardTitle className="text-lg leading-snug">{result.title}</CardTitle>
                      <CardDescription className="mt-2">
                        {result.authors.join(", ")} - {result.journal}, {result.year}
                      </CardDescription>
                    </div>
                    <div className="min-w-28 text-right">
                      <p className="text-sm font-medium">{result.score}% match</p>
                      <Progress value={result.score} className="mt-2" />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={result.extractionSource === "full_text" ? "success" : "secondary"} className="dark:border-white/10 dark:bg-white/10 dark:text-cyan-100">
                      {result.extractionNotice}
                    </Badge>
                    {evidenceSearch?.evidence?.[index]?.confidenceLabel ? (
                      <Badge variant="outline" className="dark:border-white/10">
                        {evidenceSearch.evidence[index].confidenceLabel}
                      </Badge>
                    ) : null}
                    {result.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="dark:border-white/10 dark:bg-white/10 dark:text-cyan-100">{tag}</Badge>
                    ))}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-5">
                  <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                    <section className="rounded-md border bg-slate-50/80 p-4 dark:bg-slate-900/70">
                      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                        <Quote className="size-4 text-primary" />
                        {result.section}
                      </div>
                      <p className="mb-3 text-xs text-muted-foreground">
                        {result.subsection ? `${result.subsection} - ` : ""}
                        Paragraph {evidenceSearch?.evidence?.[index]?.paragraphNumber ?? "N/A"}
                        {evidenceSearch?.evidence?.[index]?.pageNumber ? ` - Page ${evidenceSearch.evidence[index].pageNumber}` : ""}
                      </p>
                      <p className="text-sm leading-6 text-slate-700 dark:text-slate-200">
                        <HighlightedParagraph text={result.highlight} terms={result.highlightedTerms ?? []} />
                      </p>
                    </section>
                    <section className="rounded-md border bg-teal-50/80 p-4 dark:bg-cyan-400/10">
                      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-teal-900 dark:text-cyan-100">
                        <Brain className="size-4" />
                        Grounded answer
                      </div>
                      <p className="text-sm leading-6 text-teal-950 dark:text-cyan-50">{result.simpleExplanation ?? result.summary}</p>
                      <div className="mt-3 rounded-md bg-white/60 p-3 text-xs leading-5 text-teal-950 dark:bg-white/10 dark:text-cyan-50">
                        <span className="font-medium">Exact support: </span>
                        {evidenceSearch?.evidence?.[index]?.highlightedSpan ?? result.highlight}
                      </div>
                      {result.explanation ? (
                        <p className="mt-3 border-t border-teal-900/10 pt-3 text-xs leading-5 text-teal-900/80 dark:border-cyan-100/10 dark:text-cyan-100/80">
                          {result.explanation}
                        </p>
                      ) : null}
                    </section>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Link2 className="size-3.5" />
                      {evidenceSearch?.evidence?.[index]?.citation ?? `DOI: ${result.doi ?? "Not available"}`}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm">
                        <FileText />
                        Cite
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleSaveJournal(result.id)}>
                        <Bookmark />
                        Save
                      </Button>
                      {result.sourceUrl ? (
                        <Button size="sm" asChild>
                          <a href={result.sourceUrl} target="_blank" rel="noreferrer">
                            Open source
                            <ArrowUpRight />
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CardContent>
              </Card>
              </motion.div>
              )) : (
                <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
                  <CardContent className="p-5">
                    <p className="text-sm text-muted-foreground">
                      No matching journal sections found in the database.
                    </p>
                  </CardContent>
                </Card>
              )}
            </AnimatePresence>
          </div>
        </div>

        <aside className="space-y-5">
          <AccountPanel
            authEmail={authEmail}
            authMessage={authMessage}
            authMode={authMode}
            authName={authName}
            authPassword={authPassword}
            isSubmitting={isAuthSubmitting}
            userEmail={user?.email}
            userName={user?.name}
            onAuthEmailChange={setAuthEmail}
            onAuthModeChange={setAuthMode}
            onAuthNameChange={setAuthName}
            onAuthPasswordChange={setAuthPassword}
            onSignOut={handleSignOut}
            onSubmit={handleAuthSubmit}
          />

          <SavedJournals bookmarks={bookmarks} />

          <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="size-4 text-primary" />
                Sources
              </CardTitle>
              <CardDescription>Databases selected for this search.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {selectedSources.length ? selectedSources.map((source) => (
                <div key={source} className="flex items-center justify-between rounded-md border bg-white/50 px-3 py-2 text-sm dark:bg-white/5">
                  <span>{source}</span>
                  <CheckCircle2 className="size-4 text-emerald-600" />
                </div>
              )) : (
                <p className="rounded-md border bg-white/50 p-3 text-sm text-muted-foreground dark:bg-white/5">
                  Sources appear after a search.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpenCheck className="size-4 text-primary" />
                AI workflow
              </CardTitle>
              <CardDescription>Visible processing states for the MVP.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pipeline.map((step, index) => (
                <div key={step} className="flex gap-3">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-semibold text-accent-foreground dark:bg-cyan-400/15 dark:text-cyan-100">
                    {index + 1}
                  </div>
                  <p className="pt-1 text-sm">{step}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FolderOpen className="size-4 text-primary" />
                Research folders
              </CardTitle>
              <CardDescription>Saved workspaces for ongoing reviews.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {collections.length ? collections.map((folder) => (
                <div key={folder.id ?? folder.name} className="rounded-md border bg-white/50 p-3 transition hover:border-primary/40 dark:bg-white/5">
                  <p className="text-sm font-medium">{folder.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {folder.savedCount ?? 0} saved papers
                  </p>
                </div>
              )) : (
                <p className="rounded-md border bg-white/50 p-3 text-sm text-muted-foreground dark:bg-white/5">
                  No collections yet.
                </p>
              )}
            </CardContent>
          </Card>

        </aside>
      </section>
    </main>
  );
}

function AppNav({
  isAuthPending,
  isDarkMode,
  userEmail,
  userImage,
  userName,
  onSignOut,
  onToggleTheme,
}: {
  isAuthPending: boolean;
  isDarkMode: boolean;
  userEmail?: string;
  userImage?: string;
  userName?: string;
  onSignOut: () => void;
  onToggleTheme: () => void;
}) {
  const displayName = userName ?? userEmail ?? "Guest";
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="sticky top-4 z-20 mx-auto max-w-7xl rounded-lg border border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/60">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-soft dark:bg-cyan-300 dark:text-slate-950">
            <Microscope className="size-5" />
          </div>
          <div>
            <p className="text-lg font-semibold leading-none">Spexivix</p>
            <p className="text-xs text-muted-foreground">AI research platform</p>
          </div>
        </div>

        <nav className="hidden items-center gap-1 md:flex">
          <Button variant="ghost" size="sm">Search</Button>
          <Button variant="ghost" size="sm">Journals</Button>
          <Button variant="ghost" size="sm">Collections</Button>
          <Button variant="ghost" size="sm">Citations</Button>
        </nav>

        <div className="flex items-center gap-2">
          <Button size="sm" className="hidden sm:inline-flex">
            <Sparkles />
            Get Started
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={onToggleTheme}
            aria-label="Toggle dark mode"
            className="bg-white/60 dark:bg-white/5"
          >
            {isDarkMode ? <Sun /> : <Moon />}
          </Button>
          <div className="flex items-center gap-2 rounded-md border bg-white/60 p-1 pr-3 dark:bg-white/5">
            <div className="flex size-8 items-center justify-center rounded-md bg-slate-950 text-white dark:bg-cyan-200 dark:text-slate-950">
              {userImage ? (
                <span
                  aria-hidden="true"
                  className="size-full rounded-md bg-cover bg-center"
                  style={{ backgroundImage: `url(${userImage})` }}
                />
              ) : userName || userEmail ? (
                <span className="text-xs font-semibold">{initials}</span>
              ) : (
                <UserRound className="size-4" />
              )}
            </div>
            <span className="hidden max-w-28 truncate text-sm font-medium sm:inline">
              {isAuthPending ? "Loading" : displayName}
            </span>
            {userEmail ? (
              <Button variant="ghost" size="sm" className="hidden h-7 px-2 text-xs sm:inline-flex" onClick={onSignOut}>
                Sign out
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}

function ResearchSidebar({
  history,
  onSelectSearch,
}: {
  history: SearchHistoryItem[];
  onSelectSearch: (value: string) => void;
}) {
  return (
    <Card className="sticky top-24 border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PanelLeft className="size-4 text-primary" />
          Search history
        </CardTitle>
        <CardDescription>Recent research trails.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {history.length ? history.map((item) => (
          <button
            key={item.id ?? item.query}
            onClick={() => onSelectSearch(item.query)}
            className="flex w-full items-center gap-3 rounded-md border bg-white/50 px-3 py-2 text-left text-sm transition hover:border-primary/40 hover:bg-white/80 dark:bg-white/5 dark:hover:bg-white/10"
          >
            <Clock3 className="size-4 shrink-0 text-muted-foreground" />
            <span>{item.query}</span>
          </button>
        )) : (
          <p className="rounded-md border bg-white/50 p-3 text-sm text-muted-foreground dark:bg-white/5">
            No searches yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestedSearchPills({
  suggestions,
  onSelectSearch,
}: {
  suggestions: string[];
  onSelectSearch: (value: string) => void;
}) {
  if (!suggestions.length) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-wrap justify-center gap-2">
      {suggestions.map((item) => (
        <Button
          key={item}
          type="button"
          variant="subtle"
          size="sm"
          onClick={() => onSelectSearch(item)}
          className="border border-white/60 bg-white/60 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/10"
        >
          {item}
        </Button>
      ))}
    </div>
  );
}

function AccountPanel({
  authEmail,
  authMessage,
  authMode,
  authName,
  authPassword,
  isSubmitting,
  userEmail,
  userName,
  onAuthEmailChange,
  onAuthModeChange,
  onAuthNameChange,
  onAuthPasswordChange,
  onSignOut,
  onSubmit,
}: {
  authEmail: string;
  authMessage: string | null;
  authMode: "sign-in" | "sign-up";
  authName: string;
  authPassword: string;
  isSubmitting: boolean;
  userEmail?: string;
  userName?: string;
  onAuthEmailChange: (value: string) => void;
  onAuthModeChange: (value: "sign-in" | "sign-up") => void;
  onAuthNameChange: (value: string) => void;
  onAuthPasswordChange: (value: string) => void;
  onSignOut: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (userEmail) {
    return (
      <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="size-4 text-primary" />
            Account
          </CardTitle>
          <CardDescription>{userName ?? userEmail}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" className="w-full" onClick={onSignOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserRound className="size-4 text-primary" />
          Account
        </CardTitle>
        <CardDescription>Use saved searches and journals.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={onSubmit}>
          {authMode === "sign-up" ? (
            <Input
              value={authName}
              onChange={(event) => onAuthNameChange(event.target.value)}
              className="h-10 text-sm"
              placeholder="Name"
              aria-label="Name"
            />
          ) : null}
          <Input
            value={authEmail}
            onChange={(event) => onAuthEmailChange(event.target.value)}
            className="h-10 text-sm"
            placeholder="Email"
            aria-label="Email"
            type="email"
          />
          <Input
            value={authPassword}
            onChange={(event) => onAuthPasswordChange(event.target.value)}
            className="h-10 text-sm"
            placeholder="Password"
            aria-label="Password"
            type="password"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={authMode === "sign-in" ? "default" : "outline"}
              size="sm"
              onClick={() => onAuthModeChange("sign-in")}
            >
              Sign in
            </Button>
            <Button
              type="button"
              variant={authMode === "sign-up" ? "default" : "outline"}
              size="sm"
              onClick={() => onAuthModeChange("sign-up")}
            >
              Sign up
            </Button>
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting || !authEmail || !authPassword}>
            {isSubmitting ? "Working" : authMode === "sign-up" ? "Create account" : "Continue"}
          </Button>
          {authMessage ? (
            <p className="text-xs text-muted-foreground">{authMessage}</p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function SavedJournals({ bookmarks }: { bookmarks: BookmarkItem[] }) {
  const journals = bookmarks.map((bookmark, index) => ({
    title: bookmark.title ?? bookmark.journalId,
    meta: `${bookmark.citationStyle ?? "APA"} citation saved`,
    tone: ["bg-cyan-500", "bg-violet-500", "bg-emerald-500"][index % 3],
  }));

  return (
    <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bookmark className="size-4 text-primary" />
          Saved journals
        </CardTitle>
        <CardDescription>Fast access to active reading lists.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {journals.length ? journals.map((journal) => (
          <div key={journal.title} className="rounded-md border bg-white/50 p-3 transition hover:border-primary/40 dark:bg-white/5">
            <div className="mb-3 flex items-center gap-2">
              <span className={`size-2.5 rounded-full ${journal.tone}`} />
              <p className="text-sm font-medium">{journal.title}</p>
            </div>
            <p className="text-xs text-muted-foreground">{journal.meta}</p>
          </div>
        )) : (
          <p className="rounded-md border bg-white/50 p-3 text-sm text-muted-foreground dark:bg-white/5">
            No saved journals yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SearchLoadingOverlay({
  progress,
  step,
  visible,
}: {
  progress: number;
  step: string;
  visible: boolean;
}) {
  if (!visible) {
    return null;
  }

  const activeIndex = Math.max(0, loadingSteps.findIndex((item) => item === step));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4 backdrop-blur-md">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="w-full max-w-lg rounded-lg border border-white/60 bg-white/90 p-6 shadow-[0_30px_90px_rgba(15,23,42,0.25)] backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/90"
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-md bg-primary text-primary-foreground dark:bg-cyan-300 dark:text-slate-950">
            <Loader2 className="size-5 animate-spin" />
          </div>
          <div>
            <p className="text-base font-semibold">Building evidence trail</p>
            <p className="text-sm text-muted-foreground">{step}</p>
          </div>
        </div>
        <Progress value={progress} className="mb-5" />
        <div className="space-y-2">
          {loadingSteps.map((item, index) => (
            <div
              key={item}
              className="flex items-center gap-3 rounded-md border bg-white/55 px-3 py-2 text-sm dark:bg-white/5"
            >
              <div className={`flex size-6 items-center justify-center rounded-md text-xs ${
                index <= activeIndex ? "bg-primary text-primary-foreground dark:bg-cyan-300 dark:text-slate-950" : "bg-muted text-muted-foreground"
              }`}
              >
                {index < activeIndex ? <CheckCircle2 className="size-3.5" /> : index + 1}
              </div>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

function EvidenceSummaryPanel({
  onJumpToEvidence,
  result,
}: {
  onJumpToEvidence: (index: number) => void;
  result: SearchResponse;
}) {
  const citations = result.citations ?? [];
  const keyFindings = result.keyFindings ?? [];

  return (
    <Card className="border-white/60 bg-white/75 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55">
      <CardHeader className="border-b bg-white/55 dark:bg-white/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <FileSearch className="size-5 text-primary" />
              Evidence answer
            </CardTitle>
            <CardDescription className="mt-2">
              Generated only from retrieved evidence. Query understood as: {result.translatedQuery ?? result.query}
            </CardDescription>
          </div>
          <Badge variant={result.confidenceLabel === "Insufficient Evidence" ? "amber" : "success"}>
            {result.confidenceLabel ?? "Evidence grounded"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-5 lg:grid-cols-[1fr_0.8fr]">
        <section className="space-y-4">
          <div className="rounded-md border bg-slate-50/80 p-4 dark:bg-slate-900/70">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Brain className="size-4 text-primary" />
              Research answer
            </div>
            <p className="text-sm leading-6 text-slate-800 dark:text-slate-100">
              {result.answer ?? "No sufficient evidence was found for this query."}
            </p>
          </div>
          <div className="rounded-md border bg-white/55 p-4 dark:bg-white/5">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <ListChecks className="size-4 text-primary" />
              Key findings
            </div>
            {keyFindings.length ? (
              <ul className="space-y-2 text-sm leading-6 text-muted-foreground">
                {keyFindings.map((finding) => (
                  <li key={finding} className="flex gap-2">
                    <CheckCircle2 className="mt-1 size-4 shrink-0 text-emerald-600" />
                    <span>{finding}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No sufficient evidence was found for this query.</p>
            )}
          </div>
        </section>
        <section className="space-y-4">
          <div className="rounded-md border bg-cyan-50/70 p-4 dark:bg-cyan-400/10">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Network className="size-4 text-primary" />
              Citation references
            </div>
            {citations.length ? (
              <div className="space-y-2">
                {citations.map((citation, index) => (
                  <button
                    key={`${citation}-${index}`}
                    onClick={() => onJumpToEvidence(index)}
                    className="flex w-full gap-3 rounded-md border bg-white/60 p-3 text-left text-xs leading-5 transition hover:border-primary/40 dark:bg-white/5"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground dark:bg-cyan-300 dark:text-slate-950">
                      {index + 1}
                    </span>
                    <span>{citation}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No citation references are available.</p>
            )}
          </div>
          <div className="rounded-md border bg-white/55 p-4 dark:bg-white/5">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <BookMarked className="size-4 text-primary" />
              Conclusion
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              {result.conclusion ?? "No sufficient evidence was found for this query."}
            </p>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function evidenceToSearchResult(evidence: EvidenceBlock): SearchResult {
  return {
    id: evidence.journalId,
    title: evidence.title,
    authors: evidence.authors,
    journal: evidence.journal,
    year: evidence.year,
    score: evidence.score,
    doi: evidence.doi,
    sourceUrl: evidence.sourceUrl,
    pdfUrl: evidence.pdfUrl,
    section: evidence.section,
    subsection: evidence.subsection,
    sectionType: evidence.extractionSource === "full_text" ? "full text" : "abstract",
    extractionSource: evidence.extractionSource,
    extractionNotice: evidence.extractionSource === "full_text" ? "Full text" : "Abstract fallback",
    highlight: evidence.paragraph,
    summary: evidence.highlightedSpan,
    explanation: `This block is ranked as ${evidence.confidenceLabel.toLowerCase()} and is traceable to the cited source.`,
    simpleExplanation: evidence.highlightedSpan,
    scientificSummary: evidence.highlightedSpan,
    keyFindings: [evidence.highlightedSpan],
    mainConclusion: evidence.highlightedSpan,
    tags: [evidence.confidenceLabel, evidence.extractionSource === "full_text" ? "Full text" : "Abstract"],
    highlightedTerms: getHighlightTerms(evidence.highlightedSpan),
  };
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: ElementType;
  label: string;
  value: string;
}) {
  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ duration: 0.2 }}
      className="rounded-lg border border-white/60 bg-white/75 p-4 shadow-soft backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/55"
    >
      <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground dark:bg-cyan-400/15 dark:text-cyan-100">
        <Icon className="size-4" />
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-normal">{value}</p>
    </motion.div>
  );
}

function HighlightedParagraph({ text, terms }: { text: string; terms: string[] }) {
  const uniqueTerms = [...new Set(terms.filter((term) => term.length > 2))];
  if (!uniqueTerms.length) {
    return <>{text}</>;
  }

  const pattern = new RegExp(`(${uniqueTerms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, index) =>
        uniqueTerms.some((term) => term.toLowerCase() === part.toLowerCase()) ? (
          <mark key={`${part}-${index}`} className="rounded bg-amber-100 px-1 py-0.5 text-slate-950 dark:bg-amber-300/20 dark:text-amber-100">
            {part}
          </mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHighlightTerms(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 4)
    .slice(0, 8);
}
