'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { whatsappAPI, type WaitingReport } from '@/lib/api'
import { useVisibleInterval } from '@/lib/visible-interval'

const POLL_MS = 60_000

/**
 * Quem espera gente há mais que o limite da regra "Cliente esperando" —
 * lido a cada minuto com a aba à vista. A página usa o mapa para o selo
 * vermelho "Esperando N min" de cada linha.
 */
export function useWaiting() {
  const [report, setReport] = useState<WaitingReport | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current || document.visibilityState === 'hidden') return
    inFlight.current = true
    try {
      const res = await whatsappAPI.getWaiting()
      if (res.success && res.data) setReport(res.data)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // Com a aba escondida o relógio para de vez (antes ele batia e só pulava a
  // leitura); ao voltar lê na hora, em vez de mostrar a fila de até 1 min atrás.
  useVisibleInterval(() => void load(), POLL_MS)

  return report
}
