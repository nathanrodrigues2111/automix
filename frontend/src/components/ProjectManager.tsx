import { useState } from "react"
import { FolderOpen, Loader2, Save } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Label } from "@/components/ui/label"
import { useProjects, useSaveProject } from "@/api/client"
import type { Project, RenderConfig } from "@/api/types"

interface ProjectManagerProps {
  mode: "save" | "load" | null
  onClose: () => void
  currentConfig: RenderConfig
  onLoad: (project: Project) => void
}

export function ProjectManager({
  mode,
  onClose,
  currentConfig,
  onLoad,
}: ProjectManagerProps) {
  const projects = useProjects()
  const save = useSaveProject()
  const [name, setName] = useState("")

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("Project name required")
      return
    }
    save.mutate(
      { name: name.trim(), config: currentConfig },
      {
        onSuccess: () => {
          toast.success("Project saved")
          setName("")
          onClose()
        },
        onError: (e) => toast.error(`Save failed: ${e.message}`),
      },
    )
  }

  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "save" ? (
              <>
                <Save className="mr-2 inline h-4 w-4" /> Save project
              </>
            ) : (
              <>
                <FolderOpen className="mr-2 inline h-4 w-4" /> Load project
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {mode === "save"
              ? "Save the current mix configuration."
              : "Pick a saved mix to load."}
          </DialogDescription>
        </DialogHeader>

        {mode === "save" && (
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My summer mashup"
            />
          </div>
        )}

        <div className="space-y-2">
          <div className="text-xs uppercase text-muted-foreground">
            Existing projects
          </div>
          {projects.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading
            </div>
          ) : (
            <ScrollArea className="h-48 rounded-md border border-border">
              <ul className="divide-y divide-border">
                {(projects.data ?? []).map((p) => (
                  <li key={p.id} className="flex items-center justify-between p-2">
                    <div>
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(p.updated_at).toLocaleString()}
                      </div>
                    </div>
                    {mode === "load" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          onLoad(p)
                          onClose()
                        }}
                      >
                        Load
                      </Button>
                    )}
                  </li>
                ))}
                {(projects.data ?? []).length === 0 && (
                  <li className="p-3 text-center text-xs text-muted-foreground">
                    No saved projects
                  </li>
                )}
              </ul>
            </ScrollArea>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {mode === "save" && (
            <Button onClick={handleSave} disabled={save.isPending}>
              {save.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
