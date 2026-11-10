import { logger, task, wait } from "@trigger.dev/sdk"

// A first task to prove the setup works: trigger it from the dashboard's Test
// tab with a payload like { "name": "Maya" }.
export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { name?: string }) => {
    const name = payload.name ?? "world"
    logger.log(`Hello, ${name}!`)

    await wait.for({ seconds: 2 })

    return { message: `Hello, ${name}!` }
  },
})
