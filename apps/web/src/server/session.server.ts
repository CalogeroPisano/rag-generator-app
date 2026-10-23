import { UserId } from "@code-to-rag/core"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { getAuth } from "./auth.server.ts"

export interface SessionUser {
  readonly id: UserId
  readonly name: string
  readonly email: string
}

const toSessionUser = (user: { id: string; name: string; email: string }): SessionUser => ({
  id: UserId.make(user.id),
  name: user.name,
  email: user.email
})

/** Current user from the session cookie, or `undefined`. */
export const getSessionUser = async (headers: Headers = getRequestHeaders()): Promise<SessionUser | undefined> => {
  const auth = await getAuth()
  const session = await auth.api.getSession({ headers })
  return session === null ? undefined : toSessionUser(session.user)
}
