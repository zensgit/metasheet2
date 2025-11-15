/**
 * 创建插件命令
 */

import * as path from 'path'
import * as fs from 'fs-extra'
import chalk from 'chalk'
import inquirer from 'inquirer'
import ora from 'ora'

interface CreateOptions {
  type: string
  template?: string
}

export async function createCommand(name: string | undefined, options: CreateOptions) {
  const spinner = ora()

  try {
    // 交互式获取插件信息
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Plugin name:',
        default: name,
        when: !name,
        validate: (input) => {
          if (!input) return 'Plugin name is required'
          if (!/^[a-z0-9-]+$/.test(input)) {
            return 'Plugin name can only contain lowercase letters, numbers, and hyphens'
          }
          return true
        }
      },
      {
        type: 'list',
        name: 'type',
        message: 'Plugin type:',
        choices: [
          { name: 'View Plugin (视图插件)', value: 'view' },
          { name: 'Field Plugin (字段插件)', value: 'field' },
          { name: 'Workflow Plugin (工作流插件)', value: 'workflow' },
          { name: 'Integration Plugin (集成插件)', value: 'integration' },
          { name: 'Data Source Plugin (数据源插件)', value: 'datasource' },
          { name: 'Utility Plugin (工具插件)', value: 'utility' }
        ],
        default: options.type
      },
      {
        type: 'input',
        name: 'displayName',
        message: 'Display name:',
        default: (answers: any) => {
          const n = name || answers.name
          return n.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        }
      },
      {
        type: 'input',
        name: 'description',
        message: 'Description:',
        default: 'A MetaSheet plugin'
      },
      {
        type: 'input',
        name: 'author',
        message: 'Author:'
      }
    ])

    const pluginName = name || answers.name
    const pluginPath = path.join(process.cwd(), 'plugins', `plugin-${answers.type}-${pluginName}`)

    // 检查目录是否已存在
    if (await fs.pathExists(pluginPath)) {
      console.log(chalk.red(`Plugin directory already exists: ${pluginPath}`))
      process.exit(1)
    }

    spinner.start('Creating plugin...')

    // 创建插件目录
    await fs.ensureDir(pluginPath)

    // 创建目录结构
    await fs.ensureDir(path.join(pluginPath, 'src'))
    await fs.ensureDir(path.join(pluginPath, 'dist'))
    await fs.ensureDir(path.join(pluginPath, 'tests'))

    // 创建 plugin.json
    const pluginJson = {
      name: `@metasheet/plugin-${answers.type}-${pluginName}`,
      version: '1.0.0',
      displayName: answers.displayName,
      description: answers.description,
      author: answers.author,
      license: 'MIT',
      engines: {
        metasheet: '>=2.0.0',
        node: '>=16.0.0'
      },
      main: {
        backend: 'dist/index.js'
      },
      contributes: getContributes(answers.type),
      permissions: getPermissions(answers.type),
      activationEvents: getActivationEvents(answers.type, pluginName)
    }

    await fs.writeJson(path.join(pluginPath, 'plugin.json'), pluginJson, { spaces: 2 })

    // 创建 package.json
    const packageJson = {
      name: pluginJson.name,
      version: pluginJson.version,
      description: pluginJson.description,
      main: 'dist/index.js',
      scripts: {
        build: 'tsc',
        dev: 'tsc -w',
        test: 'vitest'
      },
      dependencies: {
        '@metasheet/core-backend': 'workspace:*'
      },
      devDependencies: {
        '@types/node': '^20.10.5',
        'typescript': '^5.3.3',
        'vitest': '^1.1.0'
      }
    }

    await fs.writeJson(path.join(pluginPath, 'package.json'), packageJson, { spaces: 2 })

    // 创建 tsconfig.json
    const tsConfig = {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        module: 'commonjs',
        outDir: './dist',
        rootDir: './src',
        noEmit: false
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist', '**/*.test.ts']
    }

    await fs.writeJson(path.join(pluginPath, 'tsconfig.json'), tsConfig, { spaces: 2 })

    // 创建主文件
    const mainContent = generateMainFile(answers.type, pluginName, answers.displayName)
    await fs.writeFile(path.join(pluginPath, 'src', 'index.ts'), mainContent)

    // 创建 README.md
    const readmeContent = generateReadme(pluginName, answers.displayName, answers.description)
    await fs.writeFile(path.join(pluginPath, 'README.md'), readmeContent)

    // 创建测试文件
    const testContent = generateTestFile(pluginName)
    await fs.writeFile(path.join(pluginPath, 'tests', 'index.test.ts'), testContent)

    spinner.succeed(chalk.green(`Plugin created successfully!`))

    console.log()
    console.log('Next steps:')
    console.log(chalk.cyan(`  cd plugins/plugin-${answers.type}-${pluginName}`))
    console.log(chalk.cyan(`  pnpm install`))
    console.log(chalk.cyan(`  pnpm dev`))
    console.log()

  } catch (error) {
    spinner.fail(chalk.red('Failed to create plugin'))
    console.error(error)
    process.exit(1)
  }
}

function getContributes(type: string): any {
  switch (type) {
    case 'view':
      return {
        views: [{
          id: 'custom-view',
          name: 'Custom View',
          icon: 'mdi-view',
          component: 'CustomView'
        }]
      }
    case 'field':
      return {
        fieldTypes: [{
          id: 'custom-field',
          name: 'Custom Field',
          icon: 'mdi-form-textbox',
          component: 'CustomField'
        }]
      }
    case 'workflow':
      return {
        triggers: [],
        actions: []
      }
    default:
      return {}
  }
}

function getPermissions(type: string): string[] {
  const common = ['database.read', 'events.emit']

  switch (type) {
    case 'view':
      return [...common, 'http.addRoute', 'websocket.broadcast']
    case 'field':
      return [...common, 'database.write']
    case 'workflow':
      return [...common, 'database.write', 'queue.push']
    case 'integration':
      return [...common, 'http.request', 'notification.send']
    case 'datasource':
      return [...common, 'database.*']
    default:
      return common
  }
}

function getActivationEvents(type: string, name: string): string[] {
  switch (type) {
    case 'view':
      return [`onView:${name}`]
    case 'field':
      return [`onFieldType:${name}`]
    default:
      return ['*']
  }
}

function generateMainFile(type: string, name: string, displayName: string): string {
  return `/**
 * ${displayName} Plugin
 */

import type { PluginLifecycle, PluginContext } from '@metasheet/core-backend/src/types/plugin'

export default class ${name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')}Plugin implements PluginLifecycle {
  private context!: PluginContext

  /**
   * Plugin activation
   */
  async activate(context: PluginContext): Promise<void> {
    this.context = context

    // Register routes, events, etc.
    this.register()

    context.logger.info('${displayName} plugin activated')
  }

  /**
   * Plugin deactivation
   */
  async deactivate(): Promise<void> {
    this.context.logger.info('${displayName} plugin deactivated')
  }

  /**
   * Register plugin functionality
   */
  private register(): void {
    // TODO: Implement plugin functionality
  }
}
`
}

function generateReadme(name: string, displayName: string, description: string): string {
  return `# ${displayName}

${description}

## Installation

\`\`\`bash
pnpm install
\`\`\`

## Development

\`\`\`bash
pnpm dev
\`\`\`

## Build

\`\`\`bash
pnpm build
\`\`\`

## Test

\`\`\`bash
pnpm test
\`\`\`
`
}

function generateTestFile(name: string): string {
  return `import { describe, it, expect } from 'vitest'

describe('${name} plugin', () => {
  it('should load successfully', () => {
    expect(true).toBe(true)
  })
})
`
}