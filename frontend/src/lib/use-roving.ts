import { useCallback, type KeyboardEvent } from 'react'

/**
 * O próximo índice de um grupo de opções (radios, itens de menu) ao apertar uma
 * seta, Home ou End. Setas dão a volta nas pontas. `null` = a tecla não é daqui.
 * Função pura para ter teste: o vitest do projeto roda em `node`, sem DOM.
 */
export function nextRovingIndex(key: string, current: number, count: number, { vertical = true, horizontal = true } = {}): number | null {
  if (count <= 0) return null
  const next = (horizontal && key === 'ArrowRight') || (vertical && key === 'ArrowDown')
  const prev = (horizontal && key === 'ArrowLeft') || (vertical && key === 'ArrowUp')
  if (next) return (current + 1) % count
  if (prev) return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/**
 * Teclado do padrão ARIA para um grupo de `role="radio"` ou `role="menuitem"`:
 * as setas movem o foco entre os filhos com o `selector` e, nos radios, também
 * escolhem (`onMove` recebe o índice). Só o ativo deve ter `tabIndex=0`.
 */
export function useRovingKeys(selector: string, onMove?: (index: number) => void, axes: { vertical?: boolean; horizontal?: boolean } = {}) {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector))
    const current = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement))
    const index = nextRovingIndex(event.key, current < 0 ? 0 : current, items.length, axes)
    if (index === null) return
    event.preventDefault()
    items[index]?.focus()
    onMove?.(index)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `axes` é um literal estável por uso
  }, [selector, onMove, axes.vertical, axes.horizontal])
}
