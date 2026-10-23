import { Link } from 'react-router'
import { useAuth } from '@/contexts/auth-context'
import { useTranslation } from '@/contexts/language-context'

/**
 * O nome do assinante como atalho para o cadastro dele (Contatos → ficha).
 *
 * A ficha é aberta pelo contrato, que é a chave que `ContactProfileService`
 * aceita, ou pela chave `c:<id>` do cadastro do SGP que ainda não tem contrato
 * (`registration`): o assinante vinculado a esse cadastro também tem ficha.
 * Sem permissão de ler contatos, ou sem nenhuma das duas chaves, fica só o nome.
 */
export function ContactLink({
  contract,
  registration,
  name,
  className = 'wrap-break-word'
}: {
  contract: string | null | undefined
  registration?: string | null
  name: string | null | undefined
  className?: string
}) {
  const { can } = useAuth()
  const { t } = useTranslation()
  const label = name || '—'
  const key = contract || registration
  if (!key || !can('contacts.read')) return <>{label}</>
  return (
    <Link
      to={`/contacts/${encodeURIComponent(key)}`}
      className={`${className} hover:text-primary hover:underline`}
      title={t('whatsapp.contact.open')}
    >
      {label}
    </Link>
  )
}
