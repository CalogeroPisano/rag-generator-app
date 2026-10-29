import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start"
import { setResponseHeaders } from "@tanstack/react-start/server"

/** Server functions are same-origin RPC: reject cross-site calls. */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn"
})

const securityHeadersMiddleware = createMiddleware().server(({ next }) => {
  setResponseHeaders(
    new Headers({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin"
    })
  )
  return next()
})

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeadersMiddleware, csrfMiddleware]
}))
