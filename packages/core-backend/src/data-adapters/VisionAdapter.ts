import { Inject, Optional } from '@wendellhu/redi'
import { IConfigService, ILogger } from '../di/identifiers'
import { HTTPAdapter } from './HTTPAdapter'
import { DataSourceConfig } from './BaseAdapter'

export interface VisionDiffResult {
  diffImage: string // Base64
  matchPercentage: number
  diffCount: number
}

export class VisionAdapter extends HTTPAdapter {
  private mockMode = false;

  static inject = [IConfigService, ILogger, [new Optional(), 'vision_config']];

  constructor(
    private configService: IConfigService,
    private logger: ILogger,
    config?: DataSourceConfig
  ) {
    super(config || {
      id: 'vision',
      name: 'Vision Adapter',
      type: 'vision',
      // Vision might be part of dedup service, or standalone
      connection: { url: 'http://localhost:8003' } 
    });
  }

  async connect(): Promise<void> {
    const url = await this.configService.get<string>('vision.url');
    const isMock = await this.configService.get<boolean>('vision.mock') ?? true;
    
    if (url) {
      this.config.connection.url = url;
      this.config.connection.baseURL = url;
    }
    
    this.mockMode = isMock;

    if (this.mockMode) {
      this.logger.info('Vision Adapter starting in MOCK mode');
      this.connected = true;
      this.onConnect();
      return;
    }

    this.logger.info(`Vision Adapter connecting to ${this.config.connection.url}`);
    await super.connect();
  }

  async generateDiff(sourceId: string, targetId: string): Promise<VisionDiffResult> {
    if (this.mockMode) {
      return {
        diffImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        matchPercentage: 95.5,
        diffCount: 3
      };
    }
    const result = await this.client!.post<VisionDiffResult>('/api/v1/vision/diff', { sourceId, targetId });
    return result.data;
  }
}
