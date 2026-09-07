# Spexivix

Next.js app for the Spexivix AI scientific journal search platform.

## Stack

- Next.js App Router
- TypeScript
- TailwindCSS
- shadcn-style UI components
- lucide-react icons
- Route Handler APIs
- Drizzle ORM
- Better Auth
- PostgreSQL with pgvector

## Run

Install dependencies with your package manager, then start the dev server:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Backend

The backend uses Next.js Route Handlers, Drizzle ORM, Better Auth, and PostgreSQL.

Start local Postgres:

```bash
npm run postgres:up
```

Create `.env.local` from `.env.example`, then generate and apply migrations:

```bash
npm run db:generate
npm run db:migrate
```

The default local database URL is:

```text
postgresql://postgres:admin123@localhost:5432/spexivix
```

Seed the database after migrating:

```bash
npm run db:seed
```

Useful endpoints:

- `GET /api/health`
- `POST /api/search`
- `GET /api/search/history`
- `GET /api/journals/:id`
- `GET|POST /api/collections`
- `GET|POST /api/bookmarks`
- `GET|POST /api/auth/[...all]`

## Notes

Search uses the Evidence Discovery Engine to retrieve real scientific literature, extract evidence chunks, rank them semantically, and ground answers in citations. The local database must run on `localhost:5432` with pgvector enabled before evidence search jobs can complete.
