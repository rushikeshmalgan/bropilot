// Proves the Firecrawl adapter works against the real service.
//
//   npx tsx scripts/smoke-firecrawl.ts
//
// Needs FIRECRAWL_API_KEY. It runs one search and reads one page, which uses
// a couple of Firecrawl credits.
import "./env"

import { hasEnv } from "./env"

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

async function main() {
  if (!hasEnv("FIRECRAWL_API_KEY")) {
    console.log("SKIP: FIRECRAWL_API_KEY is not set.")
    return
  }

  const { getWebProvider } = await import("@/lib/providers")
  const { webTools } = await import("@/lib/agent/tools/web")
  const web = getWebProvider()
  if (!web) {
    fail("FIRECRAWL_API_KEY is set but isn't a usable key (masked value?).")
  }

  const results = await web.search("Firecrawl documentation", 2)
  if (results.length === 0 || !results[0].url.startsWith("http")) {
    fail("the search returned no usable results")
  }
  console.log(`ok   search returned ${results.length} result(s)`)

  const page = await web.scrape("https://example.com/")
  if (!page.markdown.includes("Example Domain")) {
    fail("the page text wasn't what example.com serves")
  }
  if (!page.finalUrl.startsWith("https://example.com")) {
    fail(`unexpected final URL: ${page.finalUrl}`)
  }
  console.log(
    `ok   read example.com (${page.markdown.length} characters, final URL reported)`
  )

  // The same call through the bot's tool, with real DNS for the safety check.
  const tools = webTools(web, { userId: "smoke", botId: "smoke", runId: "smoke" })
  const blocked = (await tools.scrapePage.execute!(
    { url: "http://169.254.169.254/latest/meta-data/" },
    { toolCallId: "smoke", messages: [] } as never
  )) as { error?: string }
  if (!blocked.error) {
    fail("the tool did not refuse a link-local address")
  }
  console.log("ok   the tool refuses a link-local address before calling out")

  console.log("PASS")
}

main().then(
  () => process.exit(0),
  (error) => fail(error instanceof Error ? error.message : String(error))
)
