import { Inject, Optional } from '@wendellhu/redi'
import { IConfigService, ILogger } from '../di/identifiers'
import { HTTPAdapter } from './HTTPAdapter'
import { QueryResult, DataSourceConfig } from './BaseAdapter'

export interface AnalysisResult {
  classification: {
    category: string
    confidence: number
  }
  features: number[] // 95-dim vector
  metadata: Record<string, unknown>
}

export interface OCRResult {
  text: string
  fields: Record<string, string> // e.g. { title: "Bolt", material: "Steel" }
}

export interface CostPrediction {
  estimated_cost: number
  currency: string
  confidence: number
  breakdown: {
    material: number
    labor: number
    overhead: number
  }
}

export class CADMLAdapter extends HTTPAdapter {
  private mockMode = false;

  static inject = [IConfigService, ILogger, [new Optional(), 'cadml_config']];

  constructor(
    private configService: IConfigService,
    private logger: ILogger,
    config?: DataSourceConfig
  ) {
    super(config || {
      id: 'cad-ml',
      name: 'CAD-ML Adapter',
      type: 'cad-ml',
      connection: { url: 'http://localhost:8004' }
    });
  }

  async connect(): Promise<void> {
    const url = await this.configService.get<string>('ai.url');
    const isMock = await this.configService.get<boolean>('ai.mock') ?? true;
    
    if (url) {
      this.config.connection.url = url;
      this.config.connection.baseURL = url;
    }
    
    this.mockMode = isMock;

    if (this.mockMode) {
      this.logger.info('CAD-ML Adapter starting in MOCK mode');
      this.connected = true;
      this.onConnect();
      return;
    }

    this.logger.info(`CAD-ML Adapter connecting to ${this.config.connection.url}`);
    await super.connect();
  }

  async analyze(fileId: string): Promise<AnalysisResult> {
    if (this.mockMode) {
      return {
        classification: {
          category: 'Fastener',
          confidence: 0.95
        },
        features: Array(95).fill(0).map(() => Math.random()),
        metadata: {
          material: 'Steel',
          weight: 0.5
        }
      };
    }
    const result = await this.client!.post<AnalysisResult>('/api/v1/analyze', { file_id: fileId });
    return result.data;
  }

  async extractText(fileId: string): Promise<OCRResult> {
    if (this.mockMode) {
      return {
        text: 'DRAWING NO: 12345\nTITLE: MOUNTING PLATE',
        fields: {
          drawing_no: '12345',
          title: 'MOUNTING PLATE',
          author: 'John Doe',
          date: '2023-10-01'
        }
      };
    }
    const result = await this.client!.post<OCRResult>('/api/v1/ocr', { file_id: fileId });
    return result.data;
  }

  async predictCost(fileId: string, params?: Record<string, unknown>): Promise<CostPrediction> {
    if (this.mockMode) {
      return {
        estimated_cost: 15.50,
        currency: 'USD',
        confidence: 0.88,
        breakdown: {
          material: 5.00,
          labor: 8.00,
          overhead: 2.50
        }
      };
    }
    const result = await this.client!.post<CostPrediction>('/api/v1/cost/predict', { file_id: fileId, ...params });
    return result.data;
  }
}
