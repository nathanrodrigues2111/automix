import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type {
  AnalyzeRequest,
  JobResponse,
  ModelsStatus,
  Project,
  ProjectCreate,
  RenderConfig,
  RenderRecord,
  RenderResponse,
  Track,
  WaveformPeaks,
} from "./types"

async function http<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
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
  return `/api/tracks/${trackId}/video`
}
