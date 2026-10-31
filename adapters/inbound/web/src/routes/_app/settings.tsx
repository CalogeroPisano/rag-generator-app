import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { ModelSettingsForm, type SettingsDraft } from "@/components/settings/model-settings-form"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { changeAdmin, getSettings, saveModelSettings } from "@/functions/settings.functions"
import { formatDateTime } from "@/lib/format"

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Impostazioni · Code-to-RAG" }] }),
  component: SettingsPage
})

function SettingsPage() {
  const { user } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => getSettings(), enabled: user.admin })

  const save = useMutation({
    mutationFn: (draft: SettingsDraft) => saveModelSettings({ data: draft }),
    onSuccess: () => {
      toast.success("Impostazioni salvate")
      void queryClient.invalidateQueries({ queryKey: ["settings"] })
    },
    onError: (error: Error) => toast.error(error.message)
  })
  const admin = useMutation({
    mutationFn: (input: { userId: string; admin: boolean }) => changeAdmin({ data: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
    onError: (error: Error) => toast.error(error.message)
  })

  if (!user.admin) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Accesso riservato</EmptyTitle>
          <EmptyDescription>Solo gli amministratori gestiscono le impostazioni dell'applicativo.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (settings.data === undefined) return <Skeleton className="h-[80vh] w-full" />
  const { users } = settings.data

  return (
    <>
      <PageHeader
        title="Impostazioni"
        description="Modelli usati dall'applicativo, con le loro API key, e amministratori."
      />
      {/* Remounted after each save, so the form starts from what is stored. */}
      <ModelSettingsForm
        key={settings.data.settings.updatedAt?.toString() ?? "environment"}
        view={settings.data.settings}
        saving={save.isPending}
        onSave={(draft) => save.mutate(draft)}
      />
      <Card>
        <CardHeader>
          <CardTitle>Amministratori</CardTitle>
          <CardDescription>
            Gestiscono queste impostazioni. Finché nessuno è stato nominato, l'amministratore è il primo account creato.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Amministratore</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Creato</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <Checkbox
                      checked={entry.admin}
                      disabled={admin.isPending}
                      aria-label={`Amministratore: ${entry.name}`}
                      onCheckedChange={(checked) => admin.mutate({ userId: entry.id, admin: checked === true })}
                    />
                  </TableCell>
                  <TableCell>
                    {entry.name} {entry.id === user.id && <Badge variant="outline">tu</Badge>}
                  </TableCell>
                  <TableCell>{entry.email}</TableCell>
                  <TableCell>{formatDateTime(entry.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
