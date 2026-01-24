
import { Injector } from '@wendellhu/redi';
import { ILogger } from '../../di/identifiers';
import { PluginLoader } from '../../core/plugin-loader';

export class PluginManager {
  static inject = [PluginLoader, Injector, ILogger];

  constructor(
    private loader: PluginLoader,
    private injector: Injector,
    private logger: ILogger
  ) {}

  public async loadDemoPlugin() {
    this.logger.warn('Demo Rating Plugin is not bundled with this build.')
  }
}
