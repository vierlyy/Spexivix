import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/db";
import { schema } from "@/db/schema";

const fallbackBaseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const fallbackHostname = (() => {
  try {
    return new URL(fallbackBaseURL).hostname;
  } catch {
    return "localhost";
  }
})();

export const auth = betterAuth({
  baseURL: {
    allowedHosts: [fallbackHostname, "localhost", "127.0.0.1"],
    fallback: fallbackBaseURL,
  },
  trustedOrigins: [
    fallbackBaseURL,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
  ],
  secret:
    process.env.BETTER_AUTH_SECRET ??
    "development-only-change-me-use-env-secret-32chars",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    useSecureCookies: fallbackBaseURL.startsWith("https://"),
  },
  plugins: [nextCookies()],
});
