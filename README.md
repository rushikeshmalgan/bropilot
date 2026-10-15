# bro-pilot

A web app for creating AI bots and chatting with them, in early development. Each signed-in user gets a sidebar of their own bots, can create new ones (name, job, instructions) and open a chat with each. The app shell and screens follow the Figma designs, and bots are saved to a Neon Postgres database. Bots don't reply yet, and messages and group chats aren't saved.

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
| Sign in / sign up        | Done        | Clerk pages at `/sign-in` and `/sign-up`, Clerk middleware in `proxy.ts`; every app page requires sign-in |
| UI kit and theming       | Done        | 61 shadcn/ui components in `components/ui`; light, dark and system themes, press `d` to toggle (the designs are dark) |
| Neon database            | Done        | Project provisioned and linked                                                                                         |
| App shell                | Done        | Sidebar with the user's bots, a "+" menu, bot search (⌘K / Ctrl+K), the Clerk user menu, and an icon-only collapsed mode (⌘B / Ctrl+B) |
| Create a bot             | Done        | "New bot" dialog with job suggestions; saves to the `bots` table and opens the bot's chat |
| Bot faces                | Placeholder | Every bot shows the project favicon; Shuffle re-rolls the stored face seed, but faces aren't generated yet |
| Chat                     | In progress | `/chat/[id]` shows the bot, message bubbles and the composer; messages only live on the page and bots don't reply yet |
| Bot screen panel         | Placeholder | The monitor button opens a side panel; the bot's live screen isn't connected yet |
| Group chats              | Not started | The "New group chat" dialog exists, but groups aren't saved (it shows a notice instead) |

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
app/              App Router: root layout, home page (/), bot chat (/chat/[id]), /sign-in and /sign-up
components/       App shell, sidebar, chat view, bot dialogs and bot avatar; components/ui holds the shadcn/ui components
hooks/            Shared React hooks
lib/              Shared utilities; lib/bots.ts reads bots, lib/actions.ts saves them, lib/db has the Drizzle client and schema
public/           Static assets
proxy.ts          Clerk middleware (Next.js proxy)
neon.ts           Neon configuration (services and branch policy)
drizzle.config.ts Drizzle Kit configuration (used by db:push)
.claude/skills/   Skills for AI coding assistants (Clerk, shadcn/ui, Neon)
```

## Deployment

Deployed on Railway from this repository: https://bro-pilot-production.up.railway.app
