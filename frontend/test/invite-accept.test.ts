import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiClient, authAPI, invitesAPI } from '@/lib/api'
import { inviteAcceptPayload, inviteFormProblem } from '@/lib/invite-accept'

const form = { username: '  consultor  ', email: ' consultor@exemplo.test ', password: 'senha-antiga' }

describe('o aceite do convite, conta nova', () => {
  it('manda nome, e-mail e senha, e nunca a bandeira de conta existente', () => {
    const corpo = inviteAcceptPayload('new', form)
    expect(corpo).toEqual({ username: 'consultor', email: 'consultor@exemplo.test', password: 'senha-antiga' })
    expect('existingAccount' in corpo).toBe(false)
  })

  it('não aceita sem e-mail', () => {
    expect(inviteFormProblem('new', { ...form, email: '' })).toBe('setup.error.emailInvalid')
    expect(inviteFormProblem('new', { ...form, email: 'sem-arroba' })).toBe('setup.error.emailInvalid')
    expect(inviteFormProblem('new', form)).toBeNull()
  })
})

describe('o aceite do convite, "já tenho conta"', () => {
  it('diz que a conta existe e não manda o e-mail, mesmo que digitado antes', () => {
    expect(inviteAcceptPayload('existing', form)).toEqual({
      existingAccount: true, username: 'consultor', password: 'senha-antiga'
    })
  })

  it('leva o código do 2FA quando ele foi pedido', () => {
    expect(inviteAcceptPayload('existing', form, '123456')).toEqual({
      existingAccount: true, username: 'consultor', password: 'senha-antiga', totpCode: '123456'
    })
  })

  it('não pede e-mail, e aceita a senha antiga como estiver', () => {
    expect(inviteFormProblem('existing', { ...form, email: '', password: 'curta' })).toBeNull()
  })

  it('nome curto e senha vazia são recusados nos dois caminhos', () => {
    for (const modo of ['new', 'existing'] as const) {
      expect(inviteFormProblem(modo, { ...form, username: 'ab' })).toBe('setup.error.usernameTooShort')
      expect(inviteFormProblem(modo, { ...form, password: '' })).toBe('setup.error.passwordTooShort')
    }
  })
})

describe('as chamadas que mudam credencial', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('ativar o 2FA leva a senha atual junto do código', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ success: false })
    await authAPI.mfaEnable('minha-senha', '123456')
    expect(post).toHaveBeenCalledWith('/auth/mfa/enable', { password: 'minha-senha', code: '123456' })
  })

  it('o aceite leva o token no corpo, e "já tenho conta" vai pela rota da conta existente', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ success: false })
    await invitesAPI.accept('tok', inviteAcceptPayload('existing', form))
    expect(post).toHaveBeenCalledWith('/invites/token/join', {
      username: 'consultor', password: 'senha-antiga', token: 'tok'
    })
    await invitesAPI.accept('tok', inviteAcceptPayload('new', form))
    expect(post).toHaveBeenLastCalledWith('/invites/token/accept', expect.objectContaining({ token: 'tok', username: 'consultor' }))
  })
})
