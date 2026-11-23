'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { messengerAPI, type MessengerMessage } from '@/lib/api'
import { isInlineImageMime } from '@/lib/messenger'
import { useTranslation } from '@/contexts/language-context'

/**
 * O anexo de uma mensagem recebida, guardado no painel.
 *
 * Buscado como blob porque a rota leva a sessão num cabeçalho e `<img src>` não
 * consegue enviá-lo. Imagem conhecida aparece na bolha; o resto só é baixado
 * quando a pessoa pede (uma conversa com vários arquivos não baixa todos para
 * desenhar a tela). Todo object URL criado é revogado ao sair.
 */
export function MessengerAttachment({ message }: { message: MessengerMessage }) {
  const { t } = useTranslation()
  const inline = isInlineImageMime(message.attachmentMime)
  const [src, setSrc] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const [busy, setBusy] = useState(false)
  const created = useRef<string[]>([])

  const remember = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob)
    created.current.push(url)
    return url
  }, [])

  useEffect(
    () => () => {
      created.current.forEach((url) => URL.revokeObjectURL(url))
      created.current = []
    },
    []
  )

  useEffect(() => {
    if (!inline) return
    let live = true
    void messengerAPI.fetchAttachment(message.id).then((result) => {
      if (!live) return
      if (!result.success || !result.blob) return setGone(true)
      setSrc(remember(result.blob))
    })
    return () => {
      live = false
    }
  }, [inline, message.id, remember])

  const download = async () => {
    setBusy(true)
    try {
      const result = await messengerAPI.fetchAttachment(message.id)
      if (!result.success || !result.blob) return setGone(true)
      const link = document.createElement('a')
      link.href = remember(result.blob)
      link.download = `${message.attachmentType ?? 'attachment'}-${message.id}`
      document.body.appendChild(link)
      link.click()
      link.remove()
    } finally {
      setBusy(false)
    }
  }

  if (gone) return <p className="text-xs text-muted-foreground">{t('messenger.attachmentGone')}</p>
  if (inline) {
    return src ? (
      <img src={src} alt={t('messenger.attachment', { type: message.attachmentType ?? '' })} className="mt-1 max-h-64 max-w-full rounded-md" />
    ) : (
      <p className="text-xs text-muted-foreground">{t('messenger.attachmentLoading')}</p>
    )
  }
  return (
    <button type="button" className="text-xs text-primary hover:underline disabled:opacity-50" disabled={busy} onClick={() => void download()}>
      {t('messenger.attachment', { type: message.attachmentType ?? '' })} · {t('messenger.downloadAttachment')}
    </button>
  )
}
