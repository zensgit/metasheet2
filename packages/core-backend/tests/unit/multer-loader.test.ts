import { describe, expect, it } from 'vitest'
import { createUploadMiddleware, loadMulter } from '../../src/types/multer'

describe('multer loader', () => {
  it('loads multer through the compatibility loader', () => {
    const multer = loadMulter()

    expect(multer).not.toBeNull()
    expect(typeof multer).toBe('function')
    expect(typeof multer?.memoryStorage).toBe('function')
  })

  it('creates upload middleware when multer is available', () => {
    const upload = createUploadMiddleware(loadMulter(), { fileSize: 1024 })

    expect(upload).not.toBeNull()
    expect(typeof upload?.single).toBe('function')
    expect(typeof upload?.array).toBe('function')
  })
})
