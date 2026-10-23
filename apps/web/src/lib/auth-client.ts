import { createAuthClient } from "better-auth/react"

/** Better Auth client: talks to `/api/auth/*` on the same origin. */
export const authClient = createAuthClient()
