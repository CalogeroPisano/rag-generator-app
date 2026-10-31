import { Settings } from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { isSignupOpen } from "@/server/auth.server"
import { runEffect } from "@/server/run.server"
import { getSessionUser } from "@/server/session.server"

/** Session for route guards (UX only: data access is protected by `authMiddleware`). */
export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const user = await getSessionUser()
  if (user === undefined) return null
  // Only shows or hides the settings link: the settings use cases check the role themselves.
  const admin = await runEffect(Settings.isAdmin(user.id))
  return { user: { id: user.id, name: user.name, email: user.email, admin } }
})

export const getSignupState = createServerFn({ method: "GET" }).handler(async () => ({
  signupOpen: await isSignupOpen()
}))
