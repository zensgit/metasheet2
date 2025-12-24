import type { FUniver } from '@univerjs/presets'

export type UniverEmbedCreateResult = {
  univer: { dispose: () => void }
  univerAPI: FUniver
}

export type UniverEmbedInstance = {
  mountEl: HTMLDivElement
  univer: { dispose: () => void }
  univerAPI: FUniver
  dispose: () => void
}

type UniverEmbedOptions = {
  exposeToWindow?: boolean
  windowKeys?: {
    univer?: string
    univerAPI?: string
  }
}

export function createUniverEmbed(
  hostEl: HTMLElement,
  create: (mountEl: HTMLDivElement) => UniverEmbedCreateResult,
  options: UniverEmbedOptions = {},
): UniverEmbedInstance {
  hostEl.innerHTML = ''
  const mountEl = document.createElement('div')
  mountEl.style.width = '100%'
  mountEl.style.height = '100%'
  hostEl.appendChild(mountEl)

  const { univer, univerAPI } = create(mountEl)

  const shouldExpose = options.exposeToWindow !== false
  const univerKey = options.windowKeys?.univer ?? '__univer'
  const univerAPIKey = options.windowKeys?.univerAPI ?? '__univerAPI'

  if (shouldExpose) {
    try {
      ;(window as any)[univerKey] = univer
      ;(window as any)[univerAPIKey] = univerAPI
    } catch {
      // ignore
    }
  }

  const dispose = () => {
    try {
      univer.dispose()
    } catch {
      // ignore
    }

    if (mountEl.parentNode === hostEl) {
      hostEl.removeChild(mountEl)
    }
  }

  return { mountEl, univer, univerAPI, dispose }
}

