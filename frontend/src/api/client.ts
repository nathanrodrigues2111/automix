import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type {
  AnalyzeRequest,
  PlaylistEntry,
  AutomixRequest,
  DeleteResponse,
  FontInfo,
  FontsResponse,
  JobResponse,
  MixRecord,
  ModelsStatus,
  Project,
  ProjectCreate,
  RefreshTitlesResponse,
  RenderConfig,
  RenderRecord,
  RenderResponse,
  Track,
  WaveformPeaks,
  YoutubeImportRequest,
} from "./types"
import { apiUrl } from "@/lib/backend"

async function http<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(input), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    let detail = ""
    try {
      detail = await res.text()
    } catch {
      // ignore
    }
    throw new Error(
      `${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
    )
  }
  return (await res.json()) as T
}

export function useTracks() {
  return useQuery({
    queryKey: ["tracks"],
    queryFn: () => http<Track[]>("/api/tracks"),
    refetchOnWindowFocus: false,
  })
}

export function useTrackWaveform(trackId: string | null) {
  return useQuery({
    queryKey: ["waveform", trackId],
    queryFn: () => http<WaveformPeaks>(`/api/tracks/${trackId}/waveform`),
    enabled: !!trackId,
    staleTime: Infinity,
  })
}

export function useAnalyze() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AnalyzeRequest) =>
      http<JobResponse>("/api/analyze", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracks"] })
    },
  })
}

export function useRender() {
  return useMutation({
    mutationFn: (body: RenderConfig) =>
      http<RenderResponse>("/api/render", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  })
}

export function useFonts() {
  return useQuery({
    queryKey: ["fonts"],
    queryFn: () => http<FontsResponse>("/api/fonts"),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })
}

export function useUploadFont() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData()
      body.append("file", file)
      // No JSON Content-Type here: the browser sets the multipart boundary.
      const res = await fetch(apiUrl("/api/fonts"), { method: "POST", body })
      if (!res.ok) {
        let detail = ""
        try {
          detail = await res.text()
        } catch {
          // ignore
        }
        throw new Error(
          `${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
        )
      }
      return (await res.json()) as FontInfo
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fonts"] })
    },
  })
}

export function useMixes() {
  return useQuery({
    queryKey: ["mixes"],
    queryFn: () => http<MixRecord[]>("/api/mixes"),
    refetchOnWindowFocus: false,
  })
}

export function useDeleteMix() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (filename: string) =>
      http<DeleteResponse>(`/api/mixes/${encodeURIComponent(filename)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mixes"] })
    },
  })
}

export function useDeleteTrack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (trackId: string) =>
      http<DeleteResponse>(`/api/tracks/${trackId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracks"] })
    },
  })
}

export function useRenameTrack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ trackId, title }: { trackId: string; title: string }) =>
      http<{ id: string; title: string }>(`/api/tracks/${trackId}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracks"] })
    },
  })
}

export interface ParsedCue {
  t_s: number | null
  title: string
}

/** Dry-run parse of pasted tracklist text (1001tracklists page copies,
 * timestamped lists) so the dialog can preview the cues before saving. */
export function useParseTracklist(text: string) {
  return useQuery({
    queryKey: ["tracklist-parse", text],
    queryFn: () =>
      http<{ cues: ParsedCue[] }>("/api/tracklist/parse", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    enabled: text.trim().length > 0,
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  })
}

export function useSetCues() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      trackId,
      text,
      auto,
    }: {
      trackId: string
      text?: string
      auto?: boolean
    }) =>
      http<{ cues: number; labeled: number }>(`/api/tracks/${trackId}/cues`, {
        method: "POST",
        body: JSON.stringify({ text: text ?? "", auto: auto ?? false }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracks"] })
    },
  })
}

export function useRefreshTitles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      http<RefreshTitlesResponse>("/api/tracks/refresh-titles", {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tracks"] })
    },
  })
}

export function useYoutubeImport() {
  return useMutation({
    mutationFn: (body: YoutubeImportRequest) =>
      http<JobResponse>("/api/youtube/import", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  })
}

export function useImportFiles() {
  return useMutation({
    mutationFn: async (files: File[]) => {
      const body = new FormData()
      for (const file of files) body.append("files", file)
      const res = await fetch(apiUrl("/api/import/files"), {
        method: "POST",
        body,
      })
      if (!res.ok) {
        let detail = ""
        try {
          detail = await res.text()
        } catch {
          // ignore
        }
        throw new Error(
          `${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
        )
      }
      return (await res.json()) as JobResponse
    },
  })
}

export function useAnalyzeAll() {
  return useMutation({
    mutationFn: () =>
      http<JobResponse>("/api/analyze-all", { method: "POST" }),
  })
}

export function useRevealFile() {
  return useMutation({
    mutationFn: (path: string) =>
      http<{ result: string }>("/api/reveal", {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
  })
}

export function useCancelJob() {
  return useMutation({
    mutationFn: (jobId: string) =>
      http<{ cancelled: string }>(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
      }),
  })
}

export function usePlaylistEntries() {
  return useMutation({
    mutationFn: (body: { url: string; max_tracks?: number | null }) =>
      http<PlaylistEntry[]>("/api/youtube/entries", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  })
}

export function useAutomix() {
  return useMutation({
    mutationFn: (body: AutomixRequest) =>
      http<JobResponse>("/api/automix", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  })
}

export function useRenders() {
  return useQuery({
    queryKey: ["renders"],
    queryFn: () => http<RenderRecord[]>("/api/renders"),
  })
}

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => http<Project[]>("/api/projects"),
  })
}

export function useActiveProject() {
  return useQuery({
    queryKey: ["project", "active"],
    queryFn: () => http<Project>("/api/projects/active"),
    refetchOnWindowFocus: false,
  })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ProjectCreate) =>
      http<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

export function useRenameProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      http<Project>(`/api/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] })
      qc.invalidateQueries({ queryKey: ["project", "active"] })
    },
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      http<DeleteResponse>(`/api/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] })
      qc.invalidateQueries({ queryKey: ["project", "active"] })
    },
  })
}

export function useActivateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      http<Project>(`/api/projects/${id}/activate`, { method: "POST" }),
    onSuccess: () => {
      // The active project defines which imports/mixes the library shows.
      qc.invalidateQueries({ queryKey: ["projects"] })
      qc.invalidateQueries({ queryKey: ["project", "active"] })
      qc.invalidateQueries({ queryKey: ["tracks"] })
      qc.invalidateQueries({ queryKey: ["mixes"] })
    },
  })
}

export function useSaveProjectConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, config }: { id: string; config: Partial<RenderConfig> }) =>
      http<Project>(`/api/projects/${id}/config`, {
        method: "PUT",
        body: JSON.stringify({ config }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", "active"] })
    },
  })
}

export function useModelsStatus(options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ["models-status"],
    queryFn: () => http<ModelsStatus>("/api/models/status"),
    refetchInterval: options?.refetchInterval,
  })
}

export function useDownloadModels() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      http<JobResponse>("/api/models/download", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models-status"] })
    },
  })
}

export function trackVideoUrl(trackId: string): string {
  return apiUrl(`/api/tracks/${trackId}/video`)
}

/** Absolute URL for a backend-served file path like "videos/exports/x.mp4". */
export function mediaUrl(relPath: string): string {
  return apiUrl(`/${relPath.replace(/^\/+/, "")}`)
}
