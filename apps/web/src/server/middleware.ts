import { createMiddleware } from "@tanstack/react-start"
import { setResponseStatus } from "@tanstack/react-start/server"
import { getSessionUser } from "./session.server.ts"

/**
 * Every server function that reads or writes application data uses this
 * middleware: the session is the data boundary, not the route guard.
 */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await getSessionUser()
  if (user === undefined) {
    setResponseStatus(401)
    throw new Error("Sessione scaduta: accedi di nuovo")
  }
  return next({ context: { user } })
})
