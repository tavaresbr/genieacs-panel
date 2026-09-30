import { Link } from 'react-router'
import { useAuth } from '@/contexts/auth-context'

/**
 * O nome do assinante como atalho para o cadastro dele (Contatos → ficha).
 *
 * A ficha é aberta pelo contrato, que é a chave que `ContactProfileService`
 * aceita. Sem permissão de ler contatos, ou sem contrato, fica só o nome.
 */
export function ContactLink({ contract, name }: { contract: string | null | undefined; name: string | null | undefined }) {
  const { can } = useAuth()
  const label = name || '—'
  if (!contract || !can('contacts.read')) return <>{label}</>
  return (
    <Link
      to={`/contacts/${encodeURIComponent(contract)}`}
      className="break-words hover:text-primary hover:underline"
    >
      {label}
    </Link>
  )
}
