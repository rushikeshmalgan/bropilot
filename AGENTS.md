<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Git

- Never create branches or worktrees, and never make commits, automatically. Only do so when the user explicitly asks for that specific action in the current request.
- Leave changes uncommitted in the working tree on the current branch, and let the user decide when and how to branch or commit.

## Database

- Change the database schema only with `npm run db:push` (`drizzle-kit push`), after editing `lib/db/schema.ts`.
- Never create or run migrations. Do not run `drizzle-kit generate` or `drizzle-kit migrate`, do not create a `drizzle/` migrations folder, and do not write SQL migration files, even if a skill or doc recommends migrations.
- This is a development project with no backward compatibility, and the data in it is worthless. Prefer data loss: never backfill, never migrate or preserve existing rows, and never spend effort keeping old data working.
- Every schema change means a clean slate. If `db:push` wants to drop or recreate columns or tables, let it (use `--force` for data-loss prompts) instead of working around it.

## README

Keep `README.md` current. Whenever the user asks you to commit (and push), update `README.md` first and include it in that same commit, so the repo on GitHub always reflects the project as it is.

- The README is for someone seeing the project for the first time. It should let them understand what the project is and how far along it is, without reading the code.
- Keep these sections accurate: what the project is, the tech stack (framework, UI, auth, hosting, database), current features and their status (done, in progress, planned), how to run it locally (install, required environment variable **names**, dev command), project structure, and deployment (live URL if there is one).
- Update only what the commit changed. Don't rewrite unrelated sections, and replace the template boilerplate rather than appending to it.
- Never put secret values in the README, including keys, tokens and connection strings. Name the environment variables only.
- If a commit changes nothing that the README describes, leave it unchanged. Don't edit it for the sake of editing it.
- Say in your reply which README sections you changed.
