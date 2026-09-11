'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { apiClient, authAPI } from '@/lib/api'
import { useNavigate } from 'react-router'
import { roleHas, type Permission } from '@/lib/permissions'
import type { User } from '@/types'

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  loading: boolean
  needsSetup: boolean
  /**
   * O que a pessoa alcança, perguntado por capacidade e não por papel.
   *
   * Existe para que nenhuma tela volte a escrever `role === 'admin'`: com
   * quatro papéis essa comparação esconde de um `owner` o que ele pode fazer e
   * oferece a um `tech` o que ele não pode. A resposta vem da matriz espelhada
   * em `@/lib/permissions`, que é a mesma do backend — e a do backend é a que
   * decide, esta só evita oferecer o que seria recusado.
   */
  can: (permission: Permission) => boolean
  /** `identifier` é o nome de usuário OU o e-mail: a rota aceita os dois. */
  login: (identifier: string, password: string) => Promise<boolean>
  completeSetup: (username: string, password: string, email: string) => Promise<boolean>
  /** Para quem chega com a sessão já pronta: o convite aceito e a personificação resgatada. */
  adoptSession: (token: string, refreshToken: string | undefined, user: User) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const setupRes = await authAPI.getSetupStatus()
        if (setupRes.success && (setupRes.data as any)?.needsSetup) {
          setNeedsSetup(true)
          setUser(null)
          setIsAuthenticated(false)
          setLoading(false)
          return
        }
      } catch (error) {
        console.error("Setup status check failed:", error)
      }

      setNeedsSetup(false)
      const token = localStorage.getItem('token')
      if (token) {
        try {
          const res = await authAPI.getCurrentUser()
          if (res.success && res.data) {
            setUser(res.data as User)
            setIsAuthenticated(true)
          } else {
            apiClient.clearTokens()
            setUser(null)
            setIsAuthenticated(false)
          }
        } catch (error) {
          console.error("Auth check failed:", error)
          apiClient.clearTokens()
          setUser(null)
          setIsAuthenticated(false)
        }
      } else {
        setUser(null)
        setIsAuthenticated(false)
      }
      setLoading(false)
    }
    checkAuthStatus()
  }, [])

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null)
      setIsAuthenticated(false)
      navigate(needsSetup ? '/setup' : '/login', { replace: true })
    }
    window.addEventListener('auth:unauthorized', handleUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized)
  }, [navigate, needsSetup])

  const login = async (identifier: string, password: string): Promise<boolean> => {
    try {
      const res = await authAPI.login(identifier, password)
      if (res.success && res.data) {
        const { token, refreshToken, user } = res.data as {
          token: string
          refreshToken: string
          user: User
        }
        apiClient.setTokens(token, refreshToken)

        setUser(user)
        setIsAuthenticated(true)

        navigate('/dashboard')
        return true
      } else {
        apiClient.clearTokens()
        setIsAuthenticated(false)
        setUser(null)
        return false
      }
    } catch (error) {
      console.error("Login failed:", error)
      setIsAuthenticated(false)
      setUser(null)
      return false
    }
  }

  const completeSetup = async (username: string, password: string, email: string): Promise<boolean> => {
    try {
      const res = await authAPI.setupAdmin(username, password, email)
      if (res.success && res.data) {
        const { token, refreshToken, user } = res.data as {
          token: string
          refreshToken: string
          user: User
        }
        apiClient.setTokens(token, refreshToken)
        setUser(user)
        setIsAuthenticated(true)
        setNeedsSetup(false)
        navigate('/dashboard')
        return true
      }
      return false
    } catch (error) {
      console.error("Setup failed:", error)
      return false
    }
  }

  /**
   * Adota uma sessão que outra tela já obteve.
   *
   * Duas telas chegam com token na mão em vez de com usuário e senha: quem
   * aceita um convite e quem resgata um bilhete de personificação. As duas
   * tinham que repetir o mesmo bloco do `login` — guardar o token, encher o
   * contexto, navegar —, e repetir isso é como uma delas acaba esquecendo de
   * uma parte.
   *
   * `refreshToken` é opcional porque a personificação não tem um, e passar
   * `undefined` para `setTokens` MANTERIA o anterior. Por isso a limpeza vem
   * antes: sem ela, um refresh token de operador sobreviveria por baixo de uma
   * sessão de personificação e a renovaria como sessão comum.
   */
  const adoptSession = (token: string, refreshToken: string | undefined, next: User) => {
    apiClient.clearTokens()
    apiClient.setTokens(token, refreshToken)
    setUser(next)
    setIsAuthenticated(true)
    setNeedsSetup(false)
  }

  const logout = () => {
    void authAPI.logout()
    apiClient.clearTokens()
    setUser(null)
    setIsAuthenticated(false)
    navigate('/login')
  }

  const can = (permission: Permission) => roleHas(user?.role, permission)

  const value = { user, isAuthenticated, loading, needsSetup, can, login, completeSetup, adoptSession, logout }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
