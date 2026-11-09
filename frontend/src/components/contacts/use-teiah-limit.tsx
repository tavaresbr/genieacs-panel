import { useCallback, type ReactNode } from 'react'
import type { ApiResponse } from '@/lib/api'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'
import { usePasswordPrompt } from '@/components/ui/password-prompt'

/**
 * A paid TeiaH consultation the month's limit refused (`teiah_limit_reached`):
 * an admin may let it through with their own password, asked here; anyone
 * else gets the refusal as it came. `retry` gives back the answer to show —
 * the original refusal, or the retried call's.
 */
export function useTeiahLimitOverride(): {
  retry: <T>(res: ApiResponse<T>, again: (password: string) => Promise<ApiResponse<T>>) => Promise<ApiResponse<T>>
  element: ReactNode
} {
  const { can } = useAuth()
  const { t } = useTranslation()
  const prompt = usePasswordPrompt()
  const { ask } = prompt

  const retry = useCallback(async <T,>(res: ApiResponse<T>, again: (password: string) => Promise<ApiResponse<T>>) => {
    if (res.success || res.code !== 'teiah_limit_reached' || !can('teiah.config')) return res
    const password = await ask(`${res.message ?? ''}\n\n${t('teiahLimit.overrideConfirm')}`.trim())
    if (!password) return res
    return again(password)
  }, [ask, can, t])

  return { retry, element: prompt.element }
}
