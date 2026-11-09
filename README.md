# bro-pilot

A web app for creating AI bots and chatting with them, in early development. Each signed-in user gets a sidebar of their own bots, can create new ones (name, job, instructions), start several chats with each bot, and set up group chats with more than one bot. Bots answer with streaming AI replies (Google Gemini), and bots, chats and messages are saved to a Neon Postgres database. The app shell and screens follow the Figma designs.

## Tech stack

| Area      | Choice                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| Framework | [Next.js](https://nextjs.org) 16 (App Router), React 19, TypeScript                                              |
| UI        | [shadcn/ui](https://ui.shadcn.com) (`base-nova` style on Base UI), Tailwind CSS v4, Lucide icons, `next-themes`  |
| Auth      | [Clerk](https://clerk.com)                                                                                       |
| Database  | [Neon](https://neon.com) Postgres: project `bro-pilot`, region `aws-us-east-2`, configured in `neon.ts`          |
| ORM       | [Drizzle ORM](https://orm.drizzle.team) with Neon's serverless HTTP driver; schema applied with `drizzle-kit push` |
| AI        | [Vercel AI SDK](https://ai-sdk.dev) 7 (`ai`, `@ai-sdk/react`) with the Google Gemini provider; chat UI from [AI Elements](https://elements.ai-sdk.dev) |
| Hosting   | [Railway](https://railway.com)                                                                                   |

## Status

| Feature                  | Status      | Notes                                                                                                                  |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Sign in / sign up        | Done        | Clerk pages at `/sign-in` and `/sign-up`, Clerk middleware in `proxy.ts`; every app page requires sign-in |
| UI kit and theming       | Done        | 61 shadcn/ui components in `components/ui`; light, dark and system themes, press `d` to toggle (the designs are dark) |
| Neon database            | Done        | Project provisioned and linked                                                                                         |
| App shell                | Done        | Sidebar with the user's bots, a "+" menu, bot search (⌘K / Ctrl+K), the Clerk user menu, and an icon-only collapsed mode (⌘B / Ctrl+B) |
| Create a bot             | Done        | "New bot" dialog with job suggestions; saves to the `bots` table and opens the bot's chat |
| Bot faces                | Done        | 50 prebuilt faces in `public/bots`; the New bot dialog picks one at random, Shuffle always changes it, and the preview updates live. The chosen face is stored on the bot and shown in the sidebar, search, chat header and its messages; bots with older seeds map to a stable face |
| Chats and messages       | Done        | `/chat/[id]` loads a chat's saved messages. A bot opens its latest chat at `/bot/[id]`, or starts one; the sidebar lists the active bot's chats with a "New chat" action, and chats can be deleted. Only the owner can open a chat; anyone else gets a 404 |
| Bot replies              | Done        | Messages go to `POST /api/chat`, which saves your message, then streams the bot's reply and saves it. The bot's name, job and instructions become its system prompt. Needs `GOOGLE_GENERATIVE_AI_API_KEY`. Each reply's token counts (input, output, total) are saved in the message's `usage` column. A model error (including a 429 from the free tier) is shown in the chat as a readable, errored message and saved with status `error`. Limits: 8000 characters per message, the last 30 messages sent to the model, 10 messages per user per minute (in memory, so per server instance) |
| Bot screen panel         | Placeholder | The monitor button opens a side panel on one-on-one chats; the bot's live screen isn't connected yet |
| Group chats              | Done        | The "New group chat" dialog saves a named chat with the chosen bots and opens it; group chats are listed in the sidebar and reopen with their messages. Start a message with `@name` to pick which bot answers; with no mention, the bot that spoke last answers |

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
| `GOOGLE_GENERATIVE_AI_API_KEY`                                                                        | Google Gemini API key for bot replies (get one at <https://aistudio.google.com/apikey>) |

To get the Neon variables, run `npx neon@latest login`, then `npx neon@latest link` and pick the `bro-pilot` project. The link command writes them to `.env.local`.

Database: edit `lib/db/schema.ts`, then run `npm run db:push` to apply it to Neon. There are no migrations; every schema change starts from a clean slate. `npm run db:studio` opens Drizzle Studio.

Other scripts: `npm run build`, `npm run start`, `npm run lint`, `npm run typecheck` and `npm run format`. Add UI components with `npx shadcn@latest add <component>`.

## Project structure

```
app/              App Router: root layout, home page (/), bot chat (/chat/[id]), open-a-bot redirect (/bot/[id]), the chat API (/api/chat), /sign-in and /sign-up
components/       App shell, sidebar, chat view, bot dialogs and bot avatar; components/ai-elements is the AI Elements chat UI; components/ui holds the shadcn/ui components
hooks/            Shared React hooks
lib/              Shared utilities; lib/ai.ts holds the model (one constant), limits and the system prompt, lib/chat-reply.ts saves a message and streams the reply, lib/rate-limit.ts is the per-user limiter, lib/chat-store.ts holds the chat and message queries (each scoped to the owner), lib/chats.ts and lib/bots.ts are the signed-in read helpers, lib/actions.ts has the server actions, lib/db has the Drizzle client and schema (bots, chats, chat_bots, messages), lib/bot-faces.ts lists the bot faces
public/           Static assets; public/bots holds the 50 bot face images (SVG)
proxy.ts          Clerk middleware (Next.js proxy)
neon.ts           Neon configuration (services and branch policy)
drizzle.config.ts Drizzle Kit configuration (used by db:push)
.claude/skills/   Skills for AI coding assistants (Clerk, shadcn/ui, Neon)
```

## Deployment

Deployed on Railway from this repository: https://bro-pilot-production.up.railway.app
