import {
  Box,
  CircleCheck,
  DataLine,
  Document,
  Grid,
  Notebook,
  User,
  Warning,
} from '@element-plus/icons-vue'
import type { Component } from 'vue'

const TEMPLATE_ICON_COMPONENTS: Record<string, Component> = {
  kanban: Grid,
  pipeline: DataLine,
  bug: Warning,
  contract: Document,
  inspection: CircleCheck,
  recruit: User,
  notes: Notebook,
  asset: Box,
}

export function resolveTemplateIcon(token: string | null | undefined): Component | null {
  const normalized = token?.trim().toLowerCase()
  return normalized ? TEMPLATE_ICON_COMPONENTS[normalized] ?? null : null
}

export function templateIconFallback(name: string | null | undefined): string {
  const [firstCharacter] = Array.from(name?.trim() ?? '')
  return firstCharacter ? firstCharacter.toUpperCase() : '?'
}
