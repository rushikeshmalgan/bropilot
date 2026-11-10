// Web search and page reading. The app only knows the WebProvider interface;
// the real one is Firecrawl, and tests use an in-memory fake.
//
// Written from the Firecrawl v2 API reference:
// - https://docs.firecrawl.dev/api-reference/endpoint/search
//   (POST https://api.firecrawl.dev/v2/search, results in data.web[])
// - https://docs.firecrawl.dev/api-reference/endpoint/scrape
//   (POST https://api.firecrawl.dev/v2/scrape, markdown in data.markdown,
//   metadata.sourceURL is the requested URL and metadata.url the final URL
//   after redirects)
export type WebSearchResult = {
  title: string
  url: string
  description: string
}

export type ScrapedPage = {
  // The address the page was finally served from, after any redirects.
  finalUrl: string
  title: string | null
  statusCode: number | null
  markdown: string
}

export interface WebProvider {
  search(query: string, limit: number): Promise<WebSearchResult[]>
  scrape(url: string): Promise<ScrapedPage>
}

// An error whose message is short and safe to show the model and the user.
export class WebProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebProviderError"
  }
}

const BASE_URL = "https://api.firecrawl.dev/v2"
const REQUEST_TIMEOUT_MS = 45_000

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  // Firecrawl documents some metadata fields as "string or array of strings".
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0]
  }
  return ""
}

function describeStatus(status: number) {
  if (status === 401 || status === 403) {
    return "The web service rejected its API key."
  }
  if (status === 402) {
    return "The web service is out of credits."
  }
  if (status === 408) {
    return "The page took too long to load."
  }
  if (status === 429) {
    return "The web service is busy. Try again in a minute."
  }
  return "The web service failed."
}

export function firecrawlProvider(apiKey: string): WebProvider {
  async function call(path: string, body: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new WebProviderError("Couldn't reach the web service.")
    }

    if (!response.ok) {
      throw new WebProviderError(describeStatus(response.status))
    }

    const json = (await response.json().catch(() => null)) as {
      success?: boolean
      data?: unknown
    } | null
    if (!json || json.success === false || json.data === undefined) {
      throw new WebProviderError("The web service failed.")
    }

    return json.data
  }

  return {
    async search(query, limit) {
      const data = (await call("/search", {
        query,
        limit,
        sources: [{ type: "web" }],
        timeout: 30_000,
      })) as { web?: unknown }

      const results = Array.isArray(data.web) ? data.web : []
      return results
        .map((item) => {
          const record = (item ?? {}) as Record<string, unknown>
          return {
            title: asString(record.title),
            url: asString(record.url),
            description: asString(record.description),
          }
        })
        .filter((result) => result.url)
    },

    async scrape(url) {
      const data = (await call("/scrape", {
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 30_000,
      })) as { markdown?: unknown; metadata?: Record<string, unknown> }

      const metadata = data.metadata ?? {}
      return {
        finalUrl: asString(metadata.url) || asString(metadata.sourceURL) || url,
        title: asString(metadata.title) || null,
        statusCode:
          typeof metadata.statusCode === "number" ? metadata.statusCode : null,
        markdown: asString(data.markdown),
      }
    },
  }
}
