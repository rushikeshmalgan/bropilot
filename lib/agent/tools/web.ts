// Web tools: search the web and read a page. Both go through the WebProvider,
// and everything they return is treated as untrusted data.
import { tool } from "ai"
import { z } from "zod"

import {
  MAX_SEARCH_RESULTS,
  MAX_TOOL_OUTPUT_CHARS,
  UNTRUSTED_NOTE,
  clip,
  toolFailure,
  type ToolContext,
} from "@/lib/agent/tools/shared"
import { MAX_URL_LENGTH, checkPublicUrl } from "@/lib/net/url-safety"
import type { WebProvider } from "@/lib/providers/firecrawl"

export function webTools(web: WebProvider, context: ToolContext) {
  return {
    webSearch: tool({
      description:
        "Search the web. Returns a few results with title, URL and a short description. Use it for current or factual information you aren't sure of.",
      inputSchema: z.object({
        query: z.string().min(1).max(300).describe("What to search for"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_RESULTS)
          .optional()
          .describe(`How many results, up to ${MAX_SEARCH_RESULTS}`),
      }),
      execute: async ({ query, limit }) => {
        try {
          const found = await web.search(query, limit ?? MAX_SEARCH_RESULTS)
          const results = found.slice(0, limit ?? MAX_SEARCH_RESULTS).map((result) => ({
            title: clip(result.title, 200).text,
            url: clip(result.url, 500).text,
            description: clip(result.description, 400).text,
          }))

          return { results, note: UNTRUSTED_NOTE }
        } catch (error) {
          return toolFailure(error, "The search failed.")
        }
      },
    }),

    scrapePage: tool({
      description:
        "Read one web page and return its main text as markdown. Only public http(s) URLs work. Long pages are cut off.",
      inputSchema: z.object({
        url: z
          .string()
          .min(1)
          .max(MAX_URL_LENGTH)
          .describe("The full URL, starting with http:// or https://"),
      }),
      execute: async ({ url }) => {
        try {
          // Refuse anything that isn't a public web address before asking for it.
          const requested = await checkPublicUrl(url, context.hostLookup)
          if (!requested.ok) {
            return { error: requested.reason }
          }

          const page = await web.scrape(requested.url.toString())

          // The page may have redirected. If it ended up somewhere that isn't
          // public, its content is thrown away unread.
          const landed = await checkPublicUrl(page.finalUrl, context.hostLookup)
          if (!landed.ok) {
            return {
              error: "That page redirected to an address that isn't allowed.",
            }
          }

          const content = clip(page.markdown, MAX_TOOL_OUTPUT_CHARS)
          return {
            url: clip(landed.url.toString(), 500).text,
            title: page.title ? clip(page.title, 200).text : null,
            content: content.text,
            truncated: content.truncated,
            note: UNTRUSTED_NOTE,
          }
        } catch (error) {
          return toolFailure(error, "The page couldn't be read.")
        }
      },
    }),
  }
}
