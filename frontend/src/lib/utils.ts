import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { getActiveLocale, getIntlLocale, translate } from "@/lib/i18n"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K'
  }
  return num.toString()
}


export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (diffInSeconds < 60) {
    return translate(getActiveLocale(), 'common.justNow')
  }

  // Intl handles the plural rules of every supported locale.
  const relative = new Intl.RelativeTimeFormat(getIntlLocale(), { numeric: 'always' })

  const diffInMinutes = Math.floor(diffInSeconds / 60)
  if (diffInMinutes < 60) {
    return relative.format(-diffInMinutes, 'minute')
  }

  const diffInHours = Math.floor(diffInMinutes / 60)
  if (diffInHours < 24) {
    return relative.format(-diffInHours, 'hour')
  }

  const diffInDays = Math.floor(diffInHours / 24)
  if (diffInDays < 7) {
    return relative.format(-diffInDays, 'day')
  }

  return formatDate(dateString)
}

export function getStatusColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'online':
    case 'up':
      return 'text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-900/30'
    case 'offline':
    case 'down':
      return 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/30'
    case 'warning':
      return 'text-yellow-600 bg-yellow-100 dark:text-yellow-400 dark:bg-yellow-900/30'
    default:
      return 'text-gray-600 bg-gray-100 dark:text-gray-400 dark:bg-gray-900/30'
  }
}

export function getSignalStrengthColor(rxpower: number | null | undefined): string {
  if (rxpower === null || rxpower === undefined) {
    return 'text-gray-500'
  }

  if (rxpower >= -25) {
    return 'text-green-600'
  } else if (rxpower >= -50) {
    return 'text-yellow-600'
  } else if (rxpower >= -75) {
    return 'text-orange-600'
  } else {
    return 'text-red-600'
  }
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  waitFor: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), waitFor)
  }
}

export function generateId(): string {
  return Math.random().toString(36).substr(2, 9)
}

export function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
  } else {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.left = '-999999px'
    textArea.style.top = '-999999px'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()
    return new Promise((resolve) => {
      resolve(document.execCommand('copy'))
      textArea.remove()
    })
  }
}

/** Formats a timestamp in the active locale and the viewer's own time zone. */
export function formatDate(isoString: string | undefined | null): string {
  if (!isoString) return translate(getActiveLocale(), 'common.na');

  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return translate(getActiveLocale(), 'common.invalidDate');

    return new Intl.DateTimeFormat(getIntlLocale(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  } catch {
    return translate(getActiveLocale(), 'common.invalidDate');
  }
}

/**
 * O nome de reserva do arquivo de exportação.
 *
 * O nome bom vem do servidor, no `Content-Disposition` — é ele quem sabe o slug
 * do provedor e é ele quem deve continuar sendo o único autor da regra. Esta
 * função existe para o caso em que o cabeçalho não chega: painel servido de
 * outra origem por um backend que ainda não o expõe. Sem ela o navegador salva
 * `tenant-export` ou, pior, um nome derivado da URL de blob.
 *
 * A data é ISO e não localizada de propósito: `toLocaleDateString()` devolve
 * `12/09/2026` em pt-BR, e barra dentro de nome de arquivo é caminho.
 */
export function exportFileName(slug: string | null | undefined, when: Date = new Date()): string {
  const quem = (slug || 'export').replace(/[^a-zA-Z0-9._-]/g, '-')
  return `skygenpanel-${quem}-${when.toISOString().slice(0, 10)}.json`
}
