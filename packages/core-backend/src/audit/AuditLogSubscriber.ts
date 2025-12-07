/**
 * AuditLogSubscriber - Structured audit log file writer
 * Sprint 7 Day 2: Subscribes to system.audit.* events and writes to JSON Lines files
 *
 * Features:
 * - JSON Lines format for efficient parsing
 * - Automatic file rotation (daily or size-based)
 * - Configurable output directory
 * - Buffer for batched writes
 * - Graceful shutdown with flush
 */

import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { messageBus } from '../integration/messaging/message-bus'
import { coreMetrics } from '../integration/metrics/metrics'
import { Logger } from '../core/logger'
import type { AuditMessageEvent } from './AuditService'

export interface AuditLogSubscriberOptions {
  /** Output directory for log files (default: ./audit-logs) */
  outputDir?: string
  /** File prefix (default: audit) */
  filePrefix?: string
  /** Maximum file size in bytes before rotation (default: 100MB) */
  maxFileSizeBytes?: number
  /** Enable daily rotation (default: true) */
  dailyRotation?: boolean
  /** Buffer size before flush (default: 100 events) */
  bufferSize?: number
  /** Flush interval in ms (default: 5000) */
  flushIntervalMs?: number
  /** Event categories to subscribe (default: all with '*') */
  categories?: string[]
  /** Enable compression for rotated files (default: false) */
  compressRotated?: boolean
}

export interface AuditLogStats {
  eventsReceived: number
  eventsWritten: number
  eventsFailed: number
  filesRotated: number
  currentFileSize: number
  currentFilePath: string
  bufferLength: number
  lastFlushTime: Date | null
}

export class AuditLogSubscriber extends EventEmitter {
  private readonly logger = new Logger('AuditLogSubscriber')
  private readonly options: Required<AuditLogSubscriberOptions>
  private subscriptionIds: string[] = []
  private buffer: AuditMessageEvent[] = []
  private currentFilePath: string = ''
  private currentFileSize: number = 0
  private currentDate: string = ''
  private flushTimer: NodeJS.Timeout | null = null
  private writeStream: fs.WriteStream | null = null
  private isShuttingDown: boolean = false

  // Stats tracking
  private stats: AuditLogStats = {
    eventsReceived: 0,
    eventsWritten: 0,
    eventsFailed: 0,
    filesRotated: 0,
    currentFileSize: 0,
    currentFilePath: '',
    bufferLength: 0,
    lastFlushTime: null
  }

  constructor(options: AuditLogSubscriberOptions = {}) {
    super()
    this.options = {
      outputDir: options.outputDir ?? './audit-logs',
      filePrefix: options.filePrefix ?? 'audit',
      maxFileSizeBytes: options.maxFileSizeBytes ?? 100 * 1024 * 1024, // 100MB
      dailyRotation: options.dailyRotation ?? true,
      bufferSize: options.bufferSize ?? 100,
      flushIntervalMs: options.flushIntervalMs ?? 5000,
      categories: options.categories ?? ['*'],
      compressRotated: options.compressRotated ?? false
    }
  }

  /**
   * Start subscribing to audit events
   */
  async start(): Promise<void> {
    // Ensure output directory exists
    await this.ensureOutputDir()

    // Initialize file
    await this.initializeFile()

    // Subscribe to audit topics based on categories
    for (const category of this.options.categories) {
      const pattern = category === '*'
        ? 'system.audit.*'
        : `system.audit.${category}.*`

      const subId = messageBus.subscribePattern(
        pattern,
        this.handleAuditEvent.bind(this),
        'audit-log-subscriber'
      )
      this.subscriptionIds.push(subId)
      this.logger.info(`Subscribed to audit events: ${pattern}`, { subscriptionId: subId })
    }

    // Start flush timer
    this.startFlushTimer()

    this.logger.info('AuditLogSubscriber started', {
      outputDir: this.options.outputDir,
      categories: this.options.categories
    })

    coreMetrics.increment('audit_subscriber_started')
  }

  /**
   * Stop subscribing and flush remaining buffer
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Unsubscribe from all topics
    for (const subId of this.subscriptionIds) {
      messageBus.unsubscribe(subId)
    }
    this.subscriptionIds = []

    // Flush remaining buffer
    await this.flush()

    // Close write stream
    await this.closeWriteStream()

    this.logger.info('AuditLogSubscriber stopped', { stats: this.stats })
    coreMetrics.increment('audit_subscriber_stopped')
  }

  /**
   * Get current statistics
   */
  getStats(): AuditLogStats {
    return {
      ...this.stats,
      currentFileSize: this.currentFileSize,
      currentFilePath: this.currentFilePath,
      bufferLength: this.buffer.length
    }
  }

  /**
   * Handle incoming audit event
   */
  private async handleAuditEvent(msg: { topic: string; payload: unknown }): Promise<void> {
    if (this.isShuttingDown) return

    const event = msg.payload as AuditMessageEvent
    this.stats.eventsReceived++
    coreMetrics.increment('audit_events_received')

    // Add to buffer
    this.buffer.push(event)

    // Flush if buffer is full
    if (this.buffer.length >= this.options.bufferSize) {
      await this.flush()
    }
  }

  /**
   * Flush buffer to file
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return

    const eventsToWrite = [...this.buffer]
    this.buffer = []

    try {
      // Check for rotation before writing
      await this.checkRotation()

      // Ensure write stream is open
      if (!this.writeStream) {
        await this.openWriteStream()
      }

      // Write events as JSON Lines
      for (const event of eventsToWrite) {
        const line = JSON.stringify(event) + '\n'
        const lineBytes = Buffer.byteLength(line, 'utf8')

        // Check if we need to rotate mid-write
        if (this.currentFileSize + lineBytes > this.options.maxFileSizeBytes) {
          await this.rotate()
        }

        await this.writeLine(line)
        this.currentFileSize += lineBytes
        this.stats.eventsWritten++
        coreMetrics.increment('audit_events_written')
      }

      this.stats.lastFlushTime = new Date()
      this.emit('flushed', { count: eventsToWrite.length })
    } catch (error) {
      // Put events back in buffer for retry
      this.buffer = [...eventsToWrite, ...this.buffer]
      this.stats.eventsFailed += eventsToWrite.length
      coreMetrics.increment('audit_events_write_failed', { count: eventsToWrite.length })

      this.logger.error('Failed to flush audit events', error instanceof Error ? error : undefined)
      this.emit('error', error)
    }
  }

  /**
   * Write a line to the current file
   */
  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.writeStream) {
        reject(new Error('Write stream not initialized'))
        return
      }

      const ok = this.writeStream.write(line, 'utf8')
      if (ok) {
        resolve()
      } else {
        // Wait for drain event
        this.writeStream.once('drain', resolve)
        this.writeStream.once('error', reject)
      }
    })
  }

  /**
   * Check if rotation is needed
   */
  private async checkRotation(): Promise<void> {
    const today = this.getDateString()

    // Daily rotation
    if (this.options.dailyRotation && today !== this.currentDate) {
      await this.rotate()
      return
    }

    // Size-based rotation
    if (this.currentFileSize >= this.options.maxFileSizeBytes) {
      await this.rotate()
    }
  }

  /**
   * Rotate the log file
   */
  private async rotate(): Promise<void> {
    this.logger.info('Rotating audit log file', {
      currentFile: this.currentFilePath,
      currentSize: this.currentFileSize
    })

    await this.closeWriteStream()
    await this.initializeFile()

    this.stats.filesRotated++
    coreMetrics.increment('audit_files_rotated')
    this.emit('rotated', { previousFile: this.currentFilePath })
  }

  /**
   * Initialize a new log file
   */
  private async initializeFile(): Promise<void> {
    this.currentDate = this.getDateString()
    this.currentFilePath = this.generateFilePath()
    this.currentFileSize = 0
    this.stats.currentFilePath = this.currentFilePath

    // Check if file exists and get its size
    try {
      const stat = await fs.promises.stat(this.currentFilePath)
      this.currentFileSize = stat.size
    } catch {
      // File doesn't exist, size is 0
    }

    await this.openWriteStream()
  }

  /**
   * Open write stream for current file
   */
  private async openWriteStream(): Promise<void> {
    this.writeStream = fs.createWriteStream(this.currentFilePath, {
      flags: 'a',
      encoding: 'utf8'
    })

    // Wait for stream to be ready
    await new Promise<void>((resolve, reject) => {
      this.writeStream!.once('open', () => resolve())
      this.writeStream!.once('error', reject)
    })

    this.logger.debug('Opened write stream', { file: this.currentFilePath })
  }

  /**
   * Close the write stream
   */
  private closeWriteStream(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.writeStream) {
        resolve()
        return
      }

      this.writeStream.end(() => {
        this.writeStream = null
        resolve()
      })
    })
  }

  /**
   * Generate file path for current date
   */
  private generateFilePath(): string {
    const timestamp = this.getDateString()
    const fileName = `${this.options.filePrefix}-${timestamp}.jsonl`
    return path.join(this.options.outputDir, fileName)
  }

  /**
   * Get current date as string (YYYY-MM-DD)
   */
  private getDateString(): string {
    return new Date().toISOString().split('T')[0]
  }

  /**
   * Ensure output directory exists
   */
  private async ensureOutputDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.options.outputDir, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }

  /**
   * Start the flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(async () => {
      try {
        await this.flush()
      } catch (error) {
        this.logger.error('Flush timer error', error instanceof Error ? error : undefined)
      }
    }, this.options.flushIntervalMs)
  }
}

// Factory function for convenience
export function createAuditLogSubscriber(
  options?: AuditLogSubscriberOptions
): AuditLogSubscriber {
  return new AuditLogSubscriber(options)
}
