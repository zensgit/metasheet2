
import { ICollectionManager } from '../di/identifiers';
import { IDashboard, IWidgetConfig, WidgetType } from '../libs/dashboard/types';
import { db } from '../db/db';

export class DashboardService {
  static inject = [ICollectionManager];

  constructor(
    private collections: ICollectionManager
  ) {}

  public async createDashboard(name: string, ownerId: string, description?: string): Promise<IDashboard> {
    const id = `dash_${Date.now()}`;
    await db
      .insertInto('meta_dashboards')
      .values({ id, name, owner_id: ownerId, description: description ?? null })
      .execute();
    return (await this.getDashboard(id))!;
  }

  public async getDashboard(id: string): Promise<IDashboard | null> {
    const dashboard = await db.selectFrom('meta_dashboards').selectAll().where('id', '=', id).executeTakeFirst();
    if (!dashboard) return null;

    const widgets = await db.selectFrom('meta_widgets')
      .selectAll()
      .where('dashboard_id', '=', id)
      .execute();
    
    return {
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description || undefined,
      ownerId: dashboard.owner_id,
      createdAt: dashboard.created_at,
      updatedAt: dashboard.updated_at,
      widgets: widgets.map(w => this.mapWidgetRowToConfig(w)),
    };
  }

  public async addWidget(dashboardId: string, widgetConfig: Partial<IWidgetConfig> & { type: WidgetType }): Promise<IWidgetConfig> {
    const id = `widget_${Date.now()}`;
    await db
      .insertInto('meta_widgets')
      .values({
        id,
        dashboard_id: dashboardId,
        type: widgetConfig.type,
        title: widgetConfig.title ?? null,
        config: JSON.stringify(widgetConfig),
      })
      .execute();

    const widget = await db.selectFrom('meta_widgets').selectAll().where('id', '=', id).executeTakeFirst();
    if (!widget) {
      throw new Error('Widget insert failed');
    }

    return this.mapWidgetRowToConfig(widget);
  }

  // TODO: updateWidget, deleteWidget, deleteDashboard etc.

  private mapWidgetRowToConfig(row: { type: string; title: string | null; config: unknown }): IWidgetConfig {
    const parsedConfig =
      typeof row.config === 'string'
        ? (JSON.parse(row.config) as Record<string, unknown>)
        : (row.config as Record<string, unknown> | null);

    const config = (parsedConfig ?? {}) as Partial<IWidgetConfig>;

    return {
      ...config,
      type: row.type as WidgetType,
      title: row.title ?? config.title,
      x: config.x ?? 0,
      y: config.y ?? 0,
      w: config.w ?? 6,
      h: config.h ?? 4,
    };
  }
}
