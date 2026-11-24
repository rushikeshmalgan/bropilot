import { getHealth } from "@/lib/health"

// A public check for the host (Railway) and for people: is the app up and can
// it reach its database? It is public on purpose and says nothing about users
// or about which settings are missing (see lib/health.ts). 503 when the
// database can't be reached, so a host that watches it can restart or alert.
export async function GET() {
  const health = await getHealth()

  return Response.json(health, {
    status: health.status === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  })
}
