import type { ComponentType } from 'react'
import type { Role, ScreenProps } from './types'

export interface Tab {
  id: string
  label: string
  roles: Role[]
  component: ComponentType<ScreenProps>
}

/** One line per screen. Roles decide who sees the tab; the API decides who may act. */
export const tabs: Tab[] = []
