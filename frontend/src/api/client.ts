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

export function useAnalyzeAll() {
  return useMutation({
    mutationFn: () =>
      http<JobResponse>("/api/analyze-all", { method: "POST" }),
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

export function useProject(id: string | null) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => http<Project>(`/api/projects/${id}`),
    enabled: !!id,
  })
}

export function useSaveProject() {
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
