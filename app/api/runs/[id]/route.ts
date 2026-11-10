import { auth } from "@clerk/nextjs/server"

import { getRunSnapshot } from "@/lib/agent/run-store"

// Where a run stands, with the reply so far. The browser polls this about once
// a second while a run is unfinished. Only the chat's owner gets an answer;
// for anyone else the run doesn't exist.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) {
    return Response.json(
      { error: "Sign in to chat.", code: "unauthorized" },
      { status: 401 }
    )
  }

  const { id } = await params
  const snapshot =
    typeof id === "string" && id.length <= 64
      ? await getRunSnapshot(userId, id)
      : null

  if (!snapshot) {
    return Response.json(
      { error: "That run doesn't exist.", code: "not_found" },
      { status: 404 }
    )
  }

  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } })
}
