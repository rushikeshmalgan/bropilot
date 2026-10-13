# bro-pilot

A Next.js web app in early development. The foundation is in place (authentication, a UI component library, theming and a Neon Postgres database), but no product features have been built yet.

## Tech stack

| Area      | Choice                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| Framework | [Next.js](https://nextjs.org) 16 (App Router), React 19, TypeScript                                              |
| UI        | [shadcn/ui](https://ui.shadcn.com) (`base-nova` style on Base UI), Tailwind CSS v4, Lucide icons, `next-themes`  |
| Auth      | [Clerk](https://clerk.com)                                                                                       |
| Database  | [Neon](https://neon.com) Postgres: project `bro-pilot`, region `aws-us-east-2`, configured in `neon.ts`          |
| ORM       | [Drizzle ORM](https://orm.drizzle.team) with Neon's serverless HTTP driver; schema applied with `drizzle-kit push` |
| Hosting   | [Railway](https://railway.com)                                                                                   |

## Status

| Feature                  | Status      | Notes                                                                                                                  |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Sign in / sign up        | Done        | Clerk pages at `/sign-in` and `/sign-up`, Clerk middleware in `proxy.ts`; the home page requires sign-in and shows a user menu |
| UI kit and theming       | Done        | 61 shadcn/ui components in `components/ui`; light, dark and system themes, press `d` to toggle                         |
| Neon database            | Done        | Project provisioned and linked                                                                                         |
| Data layer (ORM, schema) | In progress | Drizzle is set up with a `bots` table (owner, name, avatar seed, job, instructions, sandbox ID); the app does not read or write it yet |
| Product features         | Not started | The home page is still the starter page                                                                                |

## Running locally

Requires Node.js 20.9 or newer.

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

Create `.env.local` before starting. It needs these variables (names only; values come from the Clerk and Neon dashboards):

| Variable                                                                                              | Used for                                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`                                               | Clerk API keys                                   |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`                                      | Paths of the Clerk sign-in and sign-up pages     |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | Where Clerk redirects after sign-in and sign-up  |
| `DATABASE_URL`                                                                                        | Neon pooled connection string                    |
| `DATABASE_URL_UNPOOLED`                                                                               | Neon direct (non-pooled) connection string       |
| `NEON_BRANCH`                                                                                         | Neon branch the variables were pulled for        |

To get the Neon variables, run `npx neon@latest login`, then `npx neon@latest link` and pick the `bro-pilot` project. The link command writes them to `.env.local`.

Database: edit `lib/db/schema.ts`, then run `npm run db:push` to apply it to Neon. There are no migrations; every schema change starts from a clean slate. `npm run db:studio` opens Drizzle Studio.

Other scripts: `npm run build`, `npm run start`, `npm run lint`, `npm run typecheck` and `npm run format`. Add UI components with `npx shadcn@latest add <component>`.

## Project structure

```
app/              App Router: root layout, home page, /sign-in and /sign-up routes
components/       Theme provider; components/ui holds the shadcn/ui components
hooks/            Shared React hooks
lib/              Shared utilities; lib/db has the Drizzle client and schema
public/           Static assets
proxy.ts          Clerk middleware (Next.js proxy)
neon.ts           Neon configuration (services and branch policy)
drizzle.config.ts Drizzle Kit configuration (used by db:push)
.claude/skills/   Skills for AI coding assistants (Clerk, shadcn/ui, Neon)
```

## Deployment

Deployed on Railway from this repository: https://bro-pilot-production.up.railway.app
