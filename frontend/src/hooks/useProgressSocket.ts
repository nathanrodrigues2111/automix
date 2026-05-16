import { useEffect, useRef, useState } from "react"
import type { ProgressMessage } from "@/api/types"

export interface ProgressEntry {
  stage: ProgressMessage["stage"]
  percent: number
  message: string
  done: boolean
  output_path?: string | null
  render_id?: string | null
}

export type ProgressMap = Record<string, ProgressEntry>

export function useProgressSocket(): ProgressMap {
  const [progress, setProgress] = useState<ProgressMap>({})
  const wsRef = useRef<WebSocket | null>(null)
  const attemptsRef = useRef(0)
  const closedRef = useRef(false)

  useEffect(() => {
    closedRef.current = false

    const connect = () => {
      if (closedRef.current) return
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
      const url = `${proto}//${window.location.host}/ws/progress`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        attemptsRef.current = 0
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as ProgressMessage
          setProgress((prev) => ({
            ...prev,
            [msg.job_id]: {
              stage: msg.stage,
              percent: msg.percent,
              message: msg.message,
              done: msg.done,
              output_path: msg.output_path ?? prev[msg.job_id]?.output_path ?? null,
              render_id: msg.render_id ?? prev[msg.job_id]?.render_id ?? null,
            },
          }))
        } catch {
          // ignore malformed payload
        }
      }

      ws.onclose = () => {
        if (closedRef.current) return
        attemptsRef.current += 1
        const delay = Math.min(
          30_000,
          1000 * Math.pow(2, attemptsRef.current - 1),
        )
        setTimeout(connect, delay)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      closedRef.current = true
      wsRef.current?.close()
    }
  }, [])

  return progress
}
