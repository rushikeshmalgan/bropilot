import { clerkMiddleware } from "@clerk/nextjs/server"

export default clerkMiddleware()

export const config = {
  matcher: [
    // /api/health is left out on purpose: a host's health check has no
    // browser session, and it must answer even if Clerk isn't set up.
    "/((?!_next|api/health|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/api/((?!health(?:/|$)).*)",
    "/trpc(.*)",
  ],
}
