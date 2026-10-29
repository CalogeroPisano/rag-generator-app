import { createServerFn } from "@tanstack/react-start"
import { isSignupOpen } from "@/server/auth.server"
import { getSessionUser } from "@/server/session.server"

/** Session for route guards (UX only: data access is protected by `authMiddleware`). */
export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const user = await getSessionUser()
  return user === undefined ? null : { user: { id: user.id, name: user.name, email: user.email } }
})

export const getSignupState = createServerFn({ method: "GET" }).handler(async () => ({
  signupOpen: await isSignupOpen()
}))
