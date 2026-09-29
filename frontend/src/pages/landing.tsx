'use client'

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { publicAPI, type PublicInfo, type PublicPlan } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { LanguageSwitcher } from '@/components/language-switcher'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { fill, landingCopy, type LandingCopy } from '@/components/landing/content'
import { HeroMockup } from '@/components/landing/hero-mockup'
import { Reveal } from '@/components/landing/reveal'

/**
 * A página pública do ápice: a vitrine de quem ainda não é provedor.
 *
 * A seção de planos lê o catálogo do banco (`/api/public/plans`) — o que o
 * console marca como público, na ordem e com o destaque que ele escolheu. O
 * "Contratar" de cada card leva ao cadastro já com o plano: `/signup?plano=`.
 *
 * Tema escuro fixo, de propósito: é a identidade da marca, e a página não é
 * tela de trabalho — ninguém passa oito horas nela.
 */

/** `5593991935695` → `(93) 99193-5695`; o que não for número do Brasil sai como veio. */
function formatPhone(digits: string) {
  const d = digits.replace(/^55(?=\d{10,11}$)/, '')
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return `+${digits}`
}

function money(cents: number, currency: string, locale: string) {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: currency || 'BRL',
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

function limitText(value: number | null, label: string, copy: LandingCopy, locale: string) {
  if (value === null) {
    const text = fill(copy.plans.unlimited, { label })
    return text.charAt(0).toUpperCase() + text.slice(1)
  }
  return `${new Intl.NumberFormat(locale).format(value)} ${label}`
}

function PlanCard({
  plan, yearly, copy, locale, onDemo
}: { plan: PublicPlan; yearly: boolean; copy: LandingCopy; locale: string; onDemo: (code: string) => void }) {
  const showYearly = yearly && plan.priceYearlyCents !== null
  const price = showYearly ? (plan.priceYearlyCents as number) : plan.priceCents
  const suffix = showYearly
    ? copy.plans.perYear
    : plan.periodDays === 30 ? copy.plans.perMonth
      : plan.periodDays === 365 ? copy.plans.perYear
        : fill(copy.plans.perDays, { days: plan.periodDays })
  const economia = showYearly && plan.priceCents > 0 && plan.periodDays === 30
    ? Math.round((1 - (plan.priceYearlyCents as number) / (plan.priceCents * 12)) * 100)
    : 0

  return (
    <div
      className={`relative flex flex-col rounded-2xl border p-7 transition duration-300 hover:-translate-y-1 ${plan.featured
        ? 'border-emerald-400/70 bg-emerald-400/[0.06] shadow-[0_0_40px_-12px] shadow-emerald-400/40'
        : 'border-white/10 bg-white/[0.03]'}`}
    >
      {plan.featured && (
        <span className="absolute -top-3 left-6 rounded-full bg-emerald-400 px-3 py-0.5 text-xs font-bold text-emerald-950">
          {copy.plans.featured}
        </span>
      )}
      <h3 className="text-lg font-bold text-white">{plan.name}</h3>
      {plan.description && <p className="mt-1 text-sm text-slate-400">{plan.description}</p>}
      <div className="mt-5 flex items-baseline gap-1">
        <span className="text-4xl font-extrabold tracking-tight text-white">
          {price === 0 ? copy.plans.free : money(price, plan.currency, locale)}
        </span>
        {price > 0 && <span className="text-sm text-slate-400">{suffix}</span>}
      </div>
      {economia > 0 && (
        <span className="mt-1 text-xs font-semibold text-emerald-300">{fill(copy.plans.yearlySave, { percent: economia })}</span>
      )}
      <p className="mt-2 text-sm text-emerald-300">
        {plan.trialDays > 0 ? fill(copy.plans.trial, { days: plan.trialDays }) : copy.plans.noTrial}
      </p>

      <ul className="mt-6 flex-1 space-y-2.5 text-sm text-slate-300">
        {[
          limitText(plan.limits.devices, copy.plans.devices, copy, locale),
          limitText(plan.limits.subscribers, copy.plans.subscribers, copy, locale),
          limitText(plan.limits.operators, copy.plans.operators, copy, locale),
          ...plan.features
        ].map((item) => (
          <li key={item} className="flex gap-2">
            <Icon name="check" size={18} className="mt-0.5 shrink-0 text-emerald-400" />
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <Link
        to={`/signup?plano=${encodeURIComponent(plan.code)}`}
        className={`mt-8 inline-flex items-center justify-center rounded-lg px-4 py-3 text-sm font-bold transition ${plan.featured
          ? 'bg-emerald-400 text-emerald-950 hover:bg-emerald-300'
          : 'border border-white/15 text-white hover:border-emerald-400/60 hover:bg-white/5'}`}
      >
        {copy.plans.choose}
      </Link>
      <button
        type="button" onClick={() => onDemo(plan.code)}
        className="mt-3 text-center text-xs text-slate-400 underline-offset-4 hover:text-white hover:underline"
      >
        {copy.plans.talk}
      </button>
    </div>
  )
}

function DemoDialog({
  copy, plans, planCode, onClose
}: { copy: LandingCopy; plans: PublicPlan[]; planCode: string; onClose: () => void }) {
  const [form, setForm] = useState({
    name: '', company: '', email: '', phone: '', city: '', devices: '', message: '', planCode, website: ''
  })
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setState('sending')
    setError('')
    try {
      const devices = Number(form.devices.replace(/\D/g, ''))
      const res = await publicAPI.createLead({
        name: form.name.trim(),
        company: form.company.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        city: form.city.trim() || undefined,
        devicesEstimate: form.devices.trim() && Number.isFinite(devices) ? devices : null,
        message: form.message.trim() || undefined,
        planCode: form.planCode || null,
        website: form.website
      })
      if (res.success) setState('done')
      else {
        setError(res.message || copy.demo.error)
        setState('error')
      }
    } catch {
      setError(copy.demo.error)
      setState('error')
    }
  }

  const field = 'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog" aria-modal="true" aria-labelledby="demo-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-white/10 bg-[#0f1c18] p-6 sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="demo-title" className="text-xl font-bold text-white">{copy.demo.title}</h2>
            <p className="mt-1 text-sm text-slate-400">{copy.demo.text}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={copy.demo.close} className="rounded p-1 text-slate-400 hover:text-white">
            <Icon name="x" size={20} />
          </button>
        </div>

        {state === 'done' ? (
          <div className="space-y-4">
            <p className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-4 text-sm text-emerald-200">{copy.demo.done}</p>
            <button type="button" onClick={onClose} className="w-full rounded-lg bg-emerald-400 px-4 py-3 text-sm font-bold text-emerald-950">
              {copy.demo.close}
            </button>
          </div>
        ) : (
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={submit}>
            {error && <p className="rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-200 sm:col-span-2" role="alert">{error}</p>}
            <input className={`${field} sm:col-span-2`} placeholder={copy.demo.name} aria-label={copy.demo.name} required maxLength={128}
              value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <input className={field} placeholder={copy.demo.company} aria-label={copy.demo.company} maxLength={160}
              value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} />
            <input className={field} placeholder={copy.demo.city} aria-label={copy.demo.city} maxLength={80}
              value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
            <input className={field} type="tel" placeholder={copy.demo.phone} aria-label={copy.demo.phone} maxLength={32}
              value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            <input className={field} type="email" placeholder={copy.demo.email} aria-label={copy.demo.email} maxLength={160}
              value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            <input className={field} inputMode="numeric" placeholder={copy.demo.devices} aria-label={copy.demo.devices}
              value={form.devices} onChange={(e) => setForm((f) => ({ ...f, devices: e.target.value }))} />
            <select className={field} aria-label={copy.demo.plan}
              value={form.planCode} onChange={(e) => setForm((f) => ({ ...f, planCode: e.target.value }))}>
              <option value="">{copy.demo.anyPlan}</option>
              {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
            </select>
            <textarea className={`${field} sm:col-span-2`} rows={3} placeholder={copy.demo.message} aria-label={copy.demo.message} maxLength={2000}
              value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} />
            {/* O campo que só robô preenche. */}
            <input className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true"
              value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} />
            <button type="submit" disabled={state === 'sending'}
              className="rounded-lg bg-emerald-400 px-4 py-3 text-sm font-bold text-emerald-950 hover:bg-emerald-300 disabled:opacity-60 sm:col-span-2">
              {state === 'sending' ? copy.demo.sending : copy.demo.submit}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

export default function Landing() {
  const { locale } = useTranslation()
  const { user } = useAuth()
  const copy = landingCopy(locale)
  const [plans, setPlans] = useState<PublicPlan[] | null>(null)
  const [info, setInfo] = useState<PublicInfo | null>(null)
  const [yearly, setYearly] = useState(false)
  const [demo, setDemo] = useState<string | null>(null)
  const [aberta, setAberta] = useState<number | null>(0)

  useEffect(() => {
    let vivo = true
    void publicAPI.plans().then((res) => { if (vivo) setPlans(res.success && res.data ? res.data.plans : []) }).catch(() => { if (vivo) setPlans([]) })
    void publicAPI.info().then((res) => { if (vivo && res.success && res.data) setInfo(res.data) }).catch(() => {})
    return () => { vivo = false }
  }, [])

  const temAnual = useMemo(() => (plans ?? []).some((plan) => plan.priceYearlyCents !== null), [plans])
  const produto = info?.productName || 'TR69'
  const [marcaA, marcaB] = /^(.*?)(\d+)$/.test(produto.split(' ')[0])
    ? [produto.split(' ')[0].replace(/\d+$/, ''), produto.split(' ')[0].match(/\d+$/)?.[0] ?? '']
    : [produto, '']
  const whatsapp = info?.contactWhatsapp ? `https://wa.me/${info.contactWhatsapp}` : null
  // Num deploy de endereço único os provedores entram no endereço
  // compartilhado, e não no login do console desta página.
  const painelExterno = !user?.platform && info?.panelUrl ? `${info.panelUrl}/login` : null
  const entrar = user?.platform ? '/platform' : '/login'

  return (
    <div className="min-h-screen bg-[#0a1411] text-slate-200 antialiased">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0a1411]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-4 sm:px-6">
          <a href="#topo" className="text-xl font-extrabold tracking-tight text-white">
            {marcaA}<span className="text-emerald-400">{marcaB}</span>
          </a>
          <nav className="ml-6 hidden gap-6 text-sm text-slate-400 md:flex">
            <a href="#recursos" className="hover:text-white">{copy.nav.features}</a>
            <a href="#como-funciona" className="hover:text-white">{copy.nav.how}</a>
            <a href="#planos" className="hover:text-white">{copy.nav.plans}</a>
            <a href="#duvidas" className="hover:text-white">{copy.nav.faq}</a>
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <LanguageSwitcher variant="dark" compact className="hidden w-12 sm:flex" />
            {painelExterno ? (
              <a href={painelExterno} className="rounded-lg border border-white/15 px-3 py-2 text-sm font-semibold text-white hover:bg-white/5 sm:px-5 sm:py-2.5">
                {copy.nav.signIn}
              </a>
            ) : (
              <Link to={entrar} className="rounded-lg border border-white/15 px-3 py-2 text-sm font-semibold text-white hover:bg-white/5 sm:px-5 sm:py-2.5">
                {copy.nav.signIn}
              </Link>
            )}
            <a href="#planos" className="rounded-lg bg-emerald-400 px-3 py-2 text-sm font-bold text-emerald-950 hover:bg-emerald-300 sm:px-5 sm:py-2.5">
              {copy.nav.signUp}
            </a>
          </div>
        </div>
      </header>

      <main id="topo">
        <section className="relative overflow-hidden">
          {/* Fundo: brilho verde e uma grade sutil que some nas bordas. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-[-18rem] h-[36rem] w-[60rem] -translate-x-1/2 rounded-full bg-emerald-500/15 blur-3xl" />
            <div
              className="absolute inset-0 opacity-[0.07]"
              style={{
                backgroundImage: 'linear-gradient(rgb(255 255 255) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255) 1px, transparent 1px)',
                backgroundSize: '48px 48px',
                maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
                WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)'
              }}
            />
          </div>

          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pb-20 pt-16 sm:px-6 sm:pt-24 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:pb-28">
            <div className="text-center lg:text-left">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                {copy.hero.kicker}
              </span>
              <h1 className="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-[3.5rem]">
                {copy.hero.titleA}{' '}
                <span className="bg-gradient-to-r from-emerald-300 to-emerald-500 bg-clip-text text-transparent">{copy.hero.titleHighlight}</span>
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-slate-400 sm:text-lg lg:mx-0">{copy.hero.subtitle}</p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
                <a href="#planos" className="rounded-lg bg-emerald-400 px-6 py-3.5 text-center text-sm font-bold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-300">
                  {copy.hero.ctaPlans}
                </a>
                <button type="button" onClick={() => setDemo('')} className="rounded-lg border border-white/15 px-6 py-3.5 text-sm font-bold text-white transition hover:bg-white/5">
                  {copy.hero.ctaDemo}
                </button>
              </div>
              <ul className="mt-8 flex flex-col items-center gap-2 text-sm text-slate-400 sm:flex-row sm:flex-wrap sm:justify-center lg:justify-start">
                {copy.hero.chips.map((chip) => (
                  <li key={chip} className="flex items-center gap-1.5">
                    <Icon name="check" size={16} className="text-emerald-400" />
                    {chip}
                  </li>
                ))}
              </ul>
            </div>
            <Reveal delay={150}>
              <HeroMockup copy={copy} />
            </Reveal>
          </div>
        </section>

        {/* A faixa de números e fabricantes. */}
        <section className="border-y border-white/5 bg-white/[0.02]">
          <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
            <dl className="grid grid-cols-2 gap-6 text-center lg:grid-cols-4">
              {copy.stats.map((stat) => (
                <div key={stat.label}>
                  <dt className="sr-only">{stat.label}</dt>
                  <dd className="text-3xl font-extrabold tracking-tight text-white">{stat.value}</dd>
                  <dd className="mt-1 text-sm text-slate-400">{stat.label}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-10 border-t border-white/5 pt-8 text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{copy.vendors.title}</p>
              <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
                {copy.vendors.items.map((vendor) => (
                  <li key={vendor} className="text-lg font-bold tracking-tight text-slate-500 transition hover:text-slate-200">{vendor}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="recursos" className="scroll-mt-20 py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold text-white sm:text-4xl">{copy.features.title}</h2>
              <p className="mt-3 text-slate-400">{copy.features.subtitle}</p>
            </div>
            <div className="mt-14 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {copy.features.items.map((item, i) => (
                <Reveal key={item.title} delay={(i % 3) * 100}>
                  <div className="group h-full rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-7 transition duration-300 hover:-translate-y-1 hover:border-emerald-400/40 hover:shadow-xl hover:shadow-emerald-500/5">
                    <span className="inline-flex size-12 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-400 ring-1 ring-emerald-400/20 transition group-hover:bg-emerald-400 group-hover:text-emerald-950">
                      <Icon name={item.icon} size={24} />
                    </span>
                    <h3 className="mt-5 text-lg font-bold text-white">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-400">{item.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section id="como-funciona" className="scroll-mt-20 border-y border-white/5 bg-white/[0.02] py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold text-white sm:text-4xl">{copy.how.title}</h2>
              <p className="mt-3 text-slate-400">{copy.how.subtitle}</p>
            </div>
            <ol className="relative mt-14 grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
              {/* A linha que liga os passos, só onde eles ficam lado a lado. */}
              <span aria-hidden="true" className="absolute left-[12.5%] right-[12.5%] top-6 hidden h-px bg-gradient-to-r from-emerald-400/0 via-emerald-400/50 to-emerald-400/0 lg:block" />
              {copy.how.steps.map((step, i) => (
                <li key={step.title} className="relative text-center">
                  <Reveal delay={i * 120}>
                    <span className="relative mx-auto flex size-12 items-center justify-center rounded-full border border-emerald-400/40 bg-[#0a1411] text-lg font-extrabold text-emerald-300 shadow-lg shadow-emerald-500/10">
                      {i + 1}
                    </span>
                    <h3 className="mt-5 text-lg font-bold text-white">{step.title}</h3>
                    <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-slate-400">{step.text}</p>
                  </Reveal>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="planos" className="scroll-mt-20 py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold text-white sm:text-4xl">{copy.plans.title}</h2>
              <p className="mt-3 text-slate-400">{copy.plans.subtitle}</p>
              {temAnual && (
                <div className="mt-6 inline-flex rounded-lg border border-white/10 p-1" role="group">
                  {([false, true] as const).map((anual) => (
                    <button
                      key={String(anual)} type="button" onClick={() => setYearly(anual)} aria-pressed={yearly === anual}
                      className={`rounded-md px-4 py-1.5 text-sm font-semibold ${yearly === anual ? 'bg-emerald-400 text-emerald-950' : 'text-slate-300'}`}
                    >
                      {anual ? copy.plans.yearly : copy.plans.monthly}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {plans === null ? (
              <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3" aria-busy="true">
                {[0, 1, 2].map((i) => <div key={i} className="h-96 animate-pulse rounded-2xl bg-white/[0.04]" />)}
              </div>
            ) : plans.length === 0 ? (
              <div className="mx-auto mt-12 max-w-xl rounded-2xl border border-white/10 p-8 text-center">
                <p className="text-slate-300">{copy.plans.empty}</p>
                <button type="button" onClick={() => setDemo('')} className="mt-5 rounded-lg bg-emerald-400 px-5 py-3 text-sm font-bold text-emerald-950">
                  {copy.hero.ctaDemo}
                </button>
              </div>
            ) : (
              <div className={`mt-12 grid grid-cols-1 gap-6 ${plans.length === 2 ? 'md:grid-cols-2 md:px-24' : plans.length >= 4 ? 'md:grid-cols-2 lg:grid-cols-4' : 'md:grid-cols-3'}`}>
                {plans.map((plan) => (
                  <PlanCard key={plan.code} plan={plan} yearly={yearly} copy={copy} locale={locale} onDemo={(code) => setDemo(code)} />
                ))}
              </div>
            )}
          </div>
        </section>

        {copy.testimonials.items.length > 0 && (
          <section className="border-t border-white/5 py-24">
            <div className="mx-auto max-w-6xl px-4 sm:px-6">
              <h2 className="text-center text-3xl font-bold text-white sm:text-4xl">{copy.testimonials.title}</h2>
              <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
                {copy.testimonials.items.map((item, i) => (
                  <Reveal key={item.name} delay={i * 100}>
                    <figure className="h-full rounded-2xl border border-white/10 bg-white/[0.03] p-6">
                      <blockquote className="text-sm leading-6 text-slate-300">“{item.quote}”</blockquote>
                      <figcaption className="mt-4 text-sm">
                        <span className="font-semibold text-white">{item.name}</span>
                        <span className="block text-slate-500">{item.role}</span>
                      </figcaption>
                    </figure>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>
        )}

        <section id="duvidas" className="scroll-mt-20 border-t border-white/5 py-24">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <h2 className="text-center text-3xl font-bold text-white sm:text-4xl">{copy.faq.title}</h2>
            <div className="mt-10 divide-y divide-white/10 rounded-2xl border border-white/10">
              {copy.faq.items.map((item, i) => (
                <div key={item.q}>
                  <button
                    type="button" onClick={() => setAberta(aberta === i ? null : i)} aria-expanded={aberta === i}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left font-semibold text-white"
                  >
                    {item.q}
                    <Icon name="chevron-down" size={18} className={`shrink-0 transition ${aberta === i ? 'rotate-180' : ''}`} />
                  </button>
                  {aberta === i && <p className="px-5 pb-5 text-sm leading-6 text-slate-400">{item.a}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 pb-24 sm:px-6">
          <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/20 via-emerald-500/5 to-transparent px-6 py-14 text-center sm:px-12">
            <div aria-hidden="true" className="absolute -right-20 -top-20 size-64 rounded-full bg-emerald-400/20 blur-3xl" />
            <h2 className="relative text-3xl font-bold text-white sm:text-4xl">{copy.cta.title}</h2>
            <p className="relative mt-3 text-slate-300">{copy.cta.text}</p>
            <div className="relative mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link to="/signup" className="rounded-lg bg-emerald-400 px-6 py-3.5 text-sm font-bold text-emerald-950 hover:bg-emerald-300">
                {copy.cta.button}
              </Link>
              <button type="button" onClick={() => setDemo('')} className="rounded-lg border border-white/15 px-6 py-3.5 text-sm font-bold text-white hover:bg-white/5">
                {copy.hero.ctaDemo}
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-black/20">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          <div className="lg:col-span-1">
            <span className="text-xl font-extrabold tracking-tight text-white">
              {marcaA}<span className="text-emerald-400">{marcaB}</span>
            </span>
            <p className="mt-3 text-sm leading-6 text-slate-400">{copy.footer.tagline}</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{copy.footer.product}</h3>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li><a href="#recursos" className="text-slate-300 hover:text-white">{copy.nav.features}</a></li>
              <li><a href="#como-funciona" className="text-slate-300 hover:text-white">{copy.nav.how}</a></li>
              <li><a href="#planos" className="text-slate-300 hover:text-white">{copy.nav.plans}</a></li>
              <li><a href="#duvidas" className="text-slate-300 hover:text-white">{copy.nav.faq}</a></li>
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{copy.footer.contact}</h3>
            <ul className="mt-4 space-y-2.5 text-sm">
              {whatsapp && info?.contactWhatsapp && (
                <li>
                  <a href={whatsapp} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-slate-300 hover:text-white">
                    <Icon name="chat" size={16} className="text-emerald-400" />
                    {formatPhone(info.contactWhatsapp)}
                  </a>
                </li>
              )}
              {info?.contactEmail && (
                <li>
                  <a href={`mailto:${info.contactEmail}`} className="text-slate-300 [overflow-wrap:anywhere] hover:text-white">{info.contactEmail}</a>
                </li>
              )}
              <li>
                <button type="button" onClick={() => setDemo('')} className="text-slate-300 hover:text-white">{copy.hero.ctaDemo}</button>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">{copy.footer.company}</h3>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              {info?.legalName && <li className="text-slate-300">{info.legalName}</li>}
              {info?.taxId && <li>{copy.footer.taxId} {info.taxId}</li>}
              {info?.address && <li className="leading-6">{info.address}</li>}
              <li>
                {painelExterno
                  ? <a href={painelExterno} className="text-slate-300 hover:text-white">{copy.nav.signIn}</a>
                  : <Link to={entrar} className="text-slate-300 hover:text-white">{copy.nav.signIn}</Link>}
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/5">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:px-6">
            <span>© {new Date().getFullYear()} {info?.legalName || produto}. {copy.footer.rights}</span>
            <Link to="/login" className="hover:text-slate-300">{copy.footer.console}</Link>
          </div>
        </div>
      </footer>

      {whatsapp && (
        <a
          href={whatsapp} target="_blank" rel="noreferrer" aria-label="WhatsApp"
          className="fixed bottom-5 right-5 z-40 inline-flex size-14 items-center justify-center rounded-full bg-[#25d366] text-white shadow-lg hover:brightness-110"
        >
          <Icon name="chat" size={28} />
        </a>
      )}

      {demo !== null && (
        <DemoDialog copy={copy} plans={plans ?? []} planCode={demo} onClose={() => setDemo(null)} />
      )}
    </div>
  )
}
