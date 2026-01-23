type UniverEmbedOptions = {
  exposeToWindow?: boolean
}

export function createUniverEmbed(
  hostEl: HTMLElement,
  factory: (mountEl: HTMLElement) => unknown,
  options: UniverEmbedOptions = {}
): { univerAPI: any; dispose: () => void } {
  const mountEl = document.createElement('div')
  mountEl.style.width = '100%'
  mountEl.style.height = '100%'
  hostEl.innerHTML = ''
  hostEl.appendChild(mountEl)

  const instance = factory(mountEl) as any
  const univerAPI = instance?.univerAPI ?? instance

  if (options.exposeToWindow) {
    ;(window as any).__univerAPI = univerAPI
  }

  const dispose = () => {
    try {
      if (instance && typeof instance.dispose === 'function') {
        instance.dispose()
      }
    } finally {
      if (mountEl.parentNode) {
        mountEl.parentNode.removeChild(mountEl)
      }
    }
  }

  return { univerAPI, dispose }
}
