import { initialsOf } from '@/lib/avatar-image'

/**
 * A foto de um operador, ou as iniciais dele quando não há foto. Decorativa:
 * o nome já está escrito ao lado, então a imagem leva `alt=""`.
 */
export function OperatorAvatar({ src, name, size = 40 }: { src?: string | null; name: string; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.4)) }
  if (src) {
    return <img src={src} alt="" width={size} height={size} style={style} className="shrink-0 rounded-full object-cover" data-testid="operator-avatar-img" />
  }
  return (
    <span
      aria-hidden="true" style={style} data-testid="operator-avatar-initials"
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground"
    >
      {initialsOf(name)}
    </span>
  )
}
