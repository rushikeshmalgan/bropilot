// Reading what a browser sends to a route.

// The largest JSON body a route that takes a chat message will read. A message
// is at most 8000 characters (up to about 32 KB with every character multi-byte),
// so this leaves room and no more.
export const MAX_JSON_BODY_BYTES = 64 * 1024

export type JsonBody =
  | { ok: true; body: unknown }
  // 413: bigger than allowed. 400: not JSON.
  | { ok: false; status: 400 | 413 }

// Reads and parses a JSON body, refusing one that is too big before parsing it.
export async function readJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<JsonBody> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413 }
  }

  let text: string
  try {
    text = await request.text()
  } catch {
    return { ok: false, status: 400 }
  }
  // The length header can be missing or wrong, so the real size is checked too.
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, status: 413 }
  }

  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400 }
  }
}
