'use client'

import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { useTenant } from '@/contexts/tenant-context'
import { useTranslation } from '@/contexts/language-context'
import { Icon } from '@/components/ui/icon'
import { visibleHeightWithKeyboard } from '@/lib/wa-keyboard'
import { visibleMenuScreens } from '@/lib/screens'
import { TAB_BAR_HREFS, useMobileBar } from '@/lib/mobile-bar'

/** O teclado do celular está aberto? Em qualquer tela: a barra sai da frente dele. */
function useKeyboardOpen() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setOpen(visibleHeightWithKeyboard({ innerHeight: window.innerHeight, vvHeight: vv.height }) !== null)
    update()
    vv.addEventListener('resize', update)
    return () => vv.removeEventListener('resize', update)
  }, [])
  return open
}

/**
 * Os atalhos fixos embaixo da tela, só no celular (`lg:hidden`): as áreas mais
 * usadas a um toque, e "Mais" abre o menu completo (a mesma gaveta do ☰).
 *
 * Os itens saem de `visibleMenuScreens`: quem não tem permissão para uma tela
 * não vê o atalho, e esta barra não guarda lista própria de telas.
 *
 * Escondida com o teclado aberto, e quando a tela pede (a conversa aberta do
 * WhatsApp). Enquanto aparece, `data-tabbar` na raiz faz a variável
 * `--tabbar-h` valer a altura dela, que a casca e a caixa do WhatsApp descontam.
 */
export function MobileTabBar({ onMore }: { onMore: () => void }) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { can, user } = useAuth()
  const { isSaas } = useTenant()
  const { hiddenBy, whatsappUnread } = useMobileBar()
  const keyboardOpen = useKeyboardOpen()

  const items = visibleMenuScreens({ can, isSaas, isPlatformAdmin: Boolean(user?.isPlatformAdmin) })
    .filter((screen) => (TAB_BAR_HREFS as readonly string[]).includes(screen.href))
    .sort((a, b) => TAB_BAR_HREFS.indexOf(a.href as typeof TAB_BAR_HREFS[number]) - TAB_BAR_HREFS.indexOf(b.href as typeof TAB_BAR_HREFS[number]))

  const hiddenRoute = ['/login', '/setup'].some((route) => pathname.startsWith(route))
  const visible = !hiddenRoute && !keyboardOpen && hiddenBy.size === 0 && items.length > 0

  useEffect(() => {
    const root = document.documentElement
    if (visible) root.dataset.tabbar = 'on'
    else delete root.dataset.tabbar
    return () => { delete root.dataset.tabbar }
  }, [visible])

  if (!visible) return null

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)
  const itemClass = (active: boolean) => `relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[0.65rem] font-medium leading-tight transition-colors ${
    active ? 'bg-white/10 text-white' : 'text-[#aeb9b3] active:bg-white/10'
  }`

  return (
    <nav
      data-mobile-tab-bar
      aria-label={t('sidebar.tab.aria')}
      className="fixed inset-x-0 bottom-0 z-1150 flex h-[calc(4rem+env(safe-area-inset-bottom))] items-stretch gap-1 border-t border-white/10 bg-[#18211d] px-1 pb-[env(safe-area-inset-bottom)] pt-1 pl-[max(0.25rem,env(safe-area-inset-left))] pr-[max(0.25rem,env(safe-area-inset-right))] text-[#f4f3ed] lg:hidden"
    >
      {items.map((screen) => {
        const active = isActive(screen.href)
        const label = screen.href === '/network-map' ? t('sidebar.tab.networkMap') : t(screen.labelKey)
        return (
          <Link key={screen.href} to={screen.href} className={itemClass(active)} aria-current={active ? 'page' : undefined}>
            {active && <span className="absolute -top-1 h-0.5 w-6 rounded-full bg-[hsl(var(--status-warning))]" aria-hidden="true" />}
            <span className="relative">
              <Icon name={screen.icon} size={21} />
              {screen.href === '/whatsapp' && whatsappUnread > 0 && (
                <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-[hsl(var(--status-warning))] px-1 text-center text-[0.6rem] font-bold leading-4 text-black">
                  {whatsappUnread > 99 ? '99+' : whatsappUnread}
                </span>
              )}
            </span>
            <span className="max-w-full truncate">{label}</span>
          </Link>
        )
      })}
      <button type="button" className={itemClass(false)} onClick={onMore}>
        <Icon name="menu" size={21} />
        <span>{t('sidebar.tab.more')}</span>
      </button>
    </nav>
  )
}
