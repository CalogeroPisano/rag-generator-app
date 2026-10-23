import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { useState, type SyntheticEvent } from "react"
import { ThemeToggle } from "@/components/theme-toggle"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { getSession, getSignupState } from "@/functions/auth.functions"
import { authClient } from "@/lib/auth-client"
import { formText } from "@/lib/form"

/** Only same-app paths are accepted as post-login destinations (no open redirects). */
const safeRedirect = (value: unknown): string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/projects"

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({ redirect: safeRedirect(search["redirect"]) }),
  beforeLoad: async ({ search }) => {
    if ((await getSession()) !== null) throw redirect({ to: search.redirect })
  },
  loader: () => getSignupState(),
  head: () => ({ meta: [{ title: "Accedi · Code-to-RAG" }] }),
  component: LoginPage
})

function LoginPage() {
  const { signupOpen } = Route.useLoaderData()
  const { redirect: destination } = Route.useSearch()
  const router = useRouter()
  const [mode, setMode] = useState<"signin" | "signup">(signupOpen ? "signup" : "signin")
  const [error, setError] = useState<string | undefined>()
  const [pending, setPending] = useState(false)

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = formText(form, "email")
    const password = formText(form, "password")
    setPending(true)
    setError(undefined)
    const result =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name: formText(form, "name") })
        : await authClient.signIn.email({ email, password })
    setPending(false)
    if (result.error) {
      setError(
        result.error.status === 401
          ? "Email o password non corretti"
          : (result.error.message ?? "Operazione non riuscita")
      )
      return
    }
    await router.invalidate()
    await router.navigate({ to: destination })
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">
            {mode === "signup" ? "Crea il tuo account" : "Accedi a Code-to-RAG"}
          </CardTitle>
          <CardDescription>
            {mode === "signup"
              ? "Il primo account creato su questa installazione è l'amministratore."
              : "Inserisci le tue credenziali per continuare."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              {error !== undefined && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {mode === "signup" && (
                <Field>
                  <FieldLabel htmlFor="name">Nome</FieldLabel>
                  <Input id="name" name="name" autoComplete="name" required />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  minLength={mode === "signup" ? 12 : undefined}
                  required
                />
                {mode === "signup" && <FieldDescription>Almeno 12 caratteri.</FieldDescription>}
              </Field>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                {mode === "signup" ? "Crea account" : "Accedi"}
              </Button>
              {signupOpen && (
                <Button type="button" variant="link" onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>
                  {mode === "signup" ? "Hai già un account? Accedi" : "Non hai un account? Registrati"}
                </Button>
              )}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
