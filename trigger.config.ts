import { defineConfig } from "@trigger.dev/sdk"

export default defineConfig({
  project: "proj_xsmjtuzjxduhijybtinf",
  dirs: ["./src/trigger"],
  // Longest a single task run may take, in seconds.
  maxDuration: 300,
})
