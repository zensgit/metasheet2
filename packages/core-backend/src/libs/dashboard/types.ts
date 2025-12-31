
import { FieldType } from '../fields/types';

export enum WidgetType {
  Table = 'Table',
  Chart = 'Chart',
  Text = 'Text',
  Image = 'Image',
  // etc.
}

export enum ChartType {
  Bar = 'Bar',
  Line = 'Line',
  Pie = 'Pie',
  Scatter = 'Scatter',
  // etc.
}

export interface IChartConfig {
  type: ChartType;
  xAxis: string; // Field ID
  yAxis: string; // Field ID
  series: Array<{
    fieldId: string;
    aggregator: 'sum' | 'avg' | 'count';
  }>;
  // More ECharts/AntV specific config
}

export interface IWidgetConfig {
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  description?: string;
  spreadsheetId?: string; // Data source
  fieldMapping?: Array<{ sourceField: string; targetField: string }>; // For generic widgets
  chartConfig?: IChartConfig; // For Chart widgets
  // Text, Image, other specific config
}

export interface IDashboard {
  id: string;
  name: string;
  description?: string;
  widgets: IWidgetConfig[];
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}
