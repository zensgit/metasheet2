import { Inject, Optional } from '@wendellhu/redi'
import { IConfigService, ILogger } from '../di/identifiers'
import { HTTPAdapter } from './HTTPAdapter'
import { QueryResult, DataSourceConfig } from './BaseAdapter'

export interface DedupSearchResult {
  id: string
  file_id: string
  file_name: string
  similarity: number // 0.0 - 1.0
  thumbnail_url?: string
  metadata?: Record<string, unknown>
}

export interface DedupCompareResult {
  similarity: number
  diff_image_base64?: string
  diff_regions?: Array<{ x: number, y: number, w: number, h: number }>
}

export class DedupCADAdapter extends HTTPAdapter {
  private mockMode = false;

  static inject = [IConfigService, ILogger, [new Optional(), 'dedup_config']];

  constructor(
    private configService: IConfigService,
    private logger: ILogger,
    config?: DataSourceConfig
  ) {
    super(config || {
      id: 'dedup',
      name: 'DedupCAD Adapter',
      type: 'dedup',
      connection: { url: 'http://localhost:8003' }
    });
  }

  async connect(): Promise<void> {
    const url = await this.configService.get<string>('dedup.url');
    const isMock = await this.configService.get<boolean>('dedup.mock') ?? true;
    
    if (url) {
      this.config.connection.url = url;
      this.config.connection.baseURL = url;
    }
    
    this.mockMode = isMock;

    if (this.mockMode) {
      this.logger.info('DedupCAD Adapter starting in MOCK mode');
      this.connected = true;
      this.onConnect();
      return;
    }

    this.logger.info(`DedupCAD Adapter connecting to ${this.config.connection.url}`);
    await super.connect();
  }

  async search(fileId: string, threshold = 0.8): Promise<QueryResult<DedupSearchResult>> {
    if (this.mockMode) {
      return {
        data: [
          { id: 'sim1', file_id: 'doc_123', file_name: 'Bolt_M6.dwg', similarity: 0.98, thumbnail_url: '/thumbs/123.png' },
          { id: 'sim2', file_id: 'doc_456', file_name: 'Bolt_M8.dwg', similarity: 0.85, thumbnail_url: '/thumbs/456.png' }
        ].filter(r => r.similarity >= threshold),
        metadata: { totalCount: 2 }
      };
    }
    return this.query<DedupSearchResult>('/api/v1/search', [{ file_id: fileId, threshold }]);
  }

  async compare(sourceId: string, targetId: string): Promise<DedupCompareResult> {
    if (this.mockMode) {
      return {
        similarity: 0.92,
        diff_image_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', // 1x1 pixel
        diff_regions: [{ x: 10, y: 10, w: 50, h: 50 }]
      };
    }
    const result = await this.client!.post<DedupCompareResult>('/api/v1/compare', { source_id: sourceId, target_id: targetId });
    return result.data;
  }
}
