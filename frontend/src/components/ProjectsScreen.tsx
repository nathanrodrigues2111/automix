import { useState } from "react"
import {
  Check,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  useActivateProject,
  useCreateProject,
  useDeleteProject,
  useProjects,
  useRenameProject,
} from "@/api/client"
import type { Project } from "@/api/types"
import { cn } from "@/lib/utils"

interface ProjectsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once a project is created or opened — closes the dialog and shows
   *  the workspace scoped to that project. */
  onOpen: () => void
}

/**
 * Project picker modal. A project is an isolated workspace with its own
 * downloaded tracks and rendered mixes. Shown on startup and reopenable from
 * the header.
 */
export function ProjectsDialog({ open, onOpenChange, onOpen }: ProjectsDialogProps) {
  const projects = useProjects()
  const create = useCreateProject()
  const rename = useRenameProject()
  const del = useDeleteProject()
  const activate = useActivateProject()

  const [newName, setNewName] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const list = projects.data ?? []

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) {
      toast.error("Project name required")
      return
    }
    create.mutate(
      { name },
      {
        onSuccess: () => {
          setNewName("")
          onOpen()
        },
        onError: (e) => toast.error(`Could not create project: ${e.message}`),
      },
    )
  }

  const handleOpen = (p: Project) => {
    activate.mutate(p.id, {
      onSuccess: () => onOpen(),
      onError: (e) => toast.error(`Could not open project: ${e.message}`),
    })
  }

  const startRename = (p: Project) => {
    setEditingId(p.id)
    setEditName(p.name)
  }

  const commitRename = (p: Project) => {
    const name = editName.trim()
    setEditingId(null)
    if (!name || name === p.name) return
    rename.mutate(
      { id: p.id, name },
      { onError: (e) => toast.error(`Rename failed: ${e.message}`) },
    )
  }

  const confirmDelete = (id: string) => {
    del.mutate(id, {
      onSuccess: () => {
        toast.success("Project deleted")
        setConfirmDeleteId(null)
      },
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[85vh] flex-col sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
              <FolderOpen className="h-4 w-4 text-primary" />
            </span>
            Projects
          </DialogTitle>
        </DialogHeader>

        {/* New project */}
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="New project name"
            aria-label="New project name"
            className="bg-background/60"
          />
          <Button
            onClick={handleCreate}
            disabled={create.isPending}
            className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Create
          </Button>
        </div>

        {/* Existing projects */}
        {projects.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border/60 p-8 text-center">
            <FolderOpen className="h-6 w-6 text-muted-foreground/50" />
            <span className="text-sm font-medium text-muted-foreground">
              No projects yet
            </span>
            <span className="text-xs text-muted-foreground/70">
              Create one above to get started
            </span>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border/60">
            <ul className="divide-y divide-border/40">
              {list.map((p) => (
                <li
                  key={p.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/20",
                    p.active && "bg-primary/5",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {editingId === p.id ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          autoFocus
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(p)
                            if (e.key === "Escape") setEditingId(null)
                          }}
                          className="h-7 text-sm"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          onClick={() => commitRename(p)}
                          aria-label="Save name"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 shrink-0"
                          onClick={() => setEditingId(null)}
                          aria-label="Cancel rename"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {p.name}
                          </span>
                          {p.active && (
                            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-primary">
                              Active
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Updated {new Date(p.updated_at).toLocaleString()}
                        </div>
                      </>
                    )}
                  </div>

                  {editingId !== p.id &&
                    (confirmDeleteId === p.id ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          Delete?
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7"
                          disabled={del.isPending}
                          onClick={() => confirmDelete(p.id)}
                        >
                          {del.isPending && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          )}
                          Yes
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          No
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => startRename(p)}
                          aria-label={`Rename ${p.name}`}
                          title="Rename"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setConfirmDeleteId(p.id)}
                          aria-label={`Delete ${p.name}`}
                          title="Delete (removes its tracks and mixes)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-1"
                          disabled={activate.isPending}
                          onClick={() => handleOpen(p)}
                        >
                          <FolderOpen className="h-3.5 w-3.5" /> Open
                        </Button>
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
