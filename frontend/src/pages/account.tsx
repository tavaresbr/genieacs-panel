import { PushNotificationsCard } from '@/components/push-notifications-card'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/**
 * Minha conta (0130): o que vale só para a pessoa logada — hoje, os avisos
 * deste aparelho e o app instalado.
 *
 * Sem `PermissionRoute`, como o mapa: o técnico que atende a ONT caída é quem
 * mais precisa do aviso no celular, e Configuração ele não abre. O que cada
 * um RECEBE o servidor filtra pelo papel.
 *
 * Fora do console e da personificação o cartão não aparece: o push é da
 * pessoa num provedor, e o servidor recusa os dois casos.
 */
export default function AccountPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const podePush = !user?.platform && !user?.impersonation

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <h1 className="page-title">{t('account.title')}</h1>
            <p className="page-description">{t('account.description')}</p>
          </div>
        </header>
        <div className="modern-card max-w-3xl p-4 sm:p-6">
          {podePush && <PushNotificationsCard />}
        </div>
      </div>
    </div>
  )
}
