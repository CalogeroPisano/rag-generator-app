import { GitError } from "../errors.ts"

/** Validates a repository URL: https only (http when allowed), no embedded credentials. */
export const validateRepositoryUrl = (raw: string, allowHttp: boolean): GitError | URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return new GitError({ reason: "invalid_url", message: "L'URL del repository non è valido" })
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return new GitError({
      reason: "invalid_url",
      message: allowHttp ? "Sono supportati solo URL http(s)" : "Sono supportati solo URL https"
    })
  }
  if (url.username !== "" || url.password !== "") {
    return new GitError({
      reason: "invalid_url",
      message: "Non inserire credenziali nell'URL: usa il campo del token di accesso"
    })
  }
  return url
}
