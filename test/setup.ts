// Runs before every test file. Nothing in the app imports from test/.
import { vi } from "vitest"

// Server actions call revalidatePath, which only works inside a Next.js request.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}))
