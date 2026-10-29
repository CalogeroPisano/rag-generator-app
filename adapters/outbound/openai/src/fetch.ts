import { Agent, fetch as undiciFetch } from "undici"

/**
 * Node's built-in fetch gives up when response headers take more than 5
 * minutes (undici's `headersTimeout`), and a model on CPU can read a long
 * prompt for longer than that before it sends the first token. Model calls use
 * undici's fetch with a dispatcher that has no headers or body timeout: the
 * only limit is `AI_TIMEOUT`, applied by the AI layer around each call.
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

export const modelFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
  undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch
