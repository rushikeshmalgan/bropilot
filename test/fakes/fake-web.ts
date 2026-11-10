import {
  WebProviderError,
  type ScrapedPage,
  type WebProvider,
  type WebSearchResult,
} from "@/lib/providers/firecrawl"

type FakePage = {
  markdown: string
  title?: string
  // Where the page "redirects" to: the address it reports being served from.
  finalUrl?: string
}

type Options = {
  pages?: Record<string, FakePage>
  results?: WebSearchResult[]
  // Makes every call fail the way the real service does when it is down.
  down?: boolean
}

// An in-memory stand-in for Firecrawl. It never touches the network.
export function fakeWeb(options: Options = {}) {
  const searches: { query: string; limit: number }[] = []
  const scrapes: string[] = []

  const provider: WebProvider = {
    async search(query, limit) {
      searches.push({ query, limit })
      if (options.down) {
        throw new WebProviderError("The web service failed.")
      }
      return options.results ?? []
    },

    async scrape(url): Promise<ScrapedPage> {
      scrapes.push(url)
      if (options.down) {
        throw new WebProviderError("The web service failed.")
      }

      const page = options.pages?.[url]
      if (!page) {
        throw new WebProviderError("The page took too long to load.")
      }
      return {
        finalUrl: page.finalUrl ?? url,
        title: page.title ?? null,
        statusCode: 200,
        markdown: page.markdown,
      }
    },
  }

  return Object.assign(provider, { searches, scrapes })
}

// A resolver for tests: names in the table resolve to the given addresses,
// anything else to a public address. No real DNS is used.
export function fakeLookup(table: Record<string, string[]> = {}) {
  return async (hostname: string) => {
    if (hostname in table) {
      const addresses = table[hostname]
      if (addresses.length === 0) {
        throw new Error("ENOTFOUND")
      }
      return addresses
    }
    return ["93.184.216.34"]
  }
}
