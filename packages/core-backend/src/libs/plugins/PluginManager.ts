
import { Injector } from '@wendellhu/redi';
import { ILogger } from '../../di/identifiers';
import { PluginLoader } from '../../core/plugin-loader';
import { DemoRatingPlugin } from '../../../plugins/demo-rating-field';

export class PluginManager {
  static inject = [PluginLoader, Injector, ILogger];

  constructor(
    private loader: PluginLoader,
    private injector: Injector,
    private logger: ILogger
  ) {}

  public async loadDemoPlugin() {
    this.logger.info('Loading Demo Rating Plugin...');
    const plugin = new DemoRatingPlugin();
    
    // Simulate context passed by loader
    const context = {
        injector: this.injector,
        metadata: { name: plugin.name, version: plugin.version, path: '' }
    } as any;

    try {
        plugin.onLoad(context);
    } catch (e) {
        this.logger.error('Failed to load demo plugin', e as Error);
    }
  }
}
