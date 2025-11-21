#!/usr/bin/env npx tsx
/**
 * Plugin Manifest Auto-Fix Script
 *
 * Automatically fixes common issues in plugin.json manifests to conform
 * to the MetaSheet PluginManifestV2 specification.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

interface OldManifest {
  id?: string;
  name?: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string | { name: string; email?: string; url?: string };
  license?: string;
  main?: string | { backend?: string };
  engines?: { metasheet?: string; node?: string };
  engine?: { metasheet: string; node?: string };
  manifestVersion?: string;
  capabilities?: any;
  permissions?: any;
  [key: string]: any;
}

interface FixedManifest {
  manifestVersion: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  author: { name: string; email?: string };
  engine: { metasheet: string; node?: string };
  main: string;
  capabilities: {
    views?: string[];
    workflows?: string[];
    dataSources?: string[];
    functions?: string[];
    triggers?: string[];
    actions?: string[];
  };
  permissions: {
    database?: { read?: string[]; write?: string[] };
    http?: { internal?: boolean };
    filesystem?: { read?: string[] };
  };
  license?: string;
  [key: string]: any;
}

function normalizeName(name: string): string {
  // Convert to lowercase and replace invalid characters
  return name
    .toLowerCase()
    .replace(/^@metasheet\//, '') // Remove namespace prefix
    .replace(/[^a-z0-9-]/g, '-') // Replace invalid chars with hyphen
    .replace(/-+/g, '-') // Remove consecutive hyphens
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

function fixManifest(original: OldManifest, filePath: string): FixedManifest {
  const changes: string[] = [];

  // Extract plugin directory name for defaults
  const dirName = path.basename(path.dirname(filePath));

  // Fix name - must be lowercase with hyphens
  let name = original.name || original.id || dirName;
  const normalizedName = normalizeName(name);
  if (name !== normalizedName) {
    changes.push(`name: "${name}" → "${normalizedName}"`);
    name = normalizedName;
  }

  // Fix manifestVersion
  const manifestVersion = original.manifestVersion || '2.0.0';
  if (!original.manifestVersion) {
    changes.push('Added manifestVersion: "2.0.0"');
  }

  // Fix version
  const version = original.version || '1.0.0';
  if (!original.version) {
    changes.push('Added version: "1.0.0"');
  }

  // Fix displayName
  let displayName = original.displayName;
  if (!displayName) {
    // Generate from name
    displayName = name
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    changes.push(`Generated displayName: "${displayName}"`);
  }

  // Fix description
  const description = original.description || `${displayName} plugin for MetaSheet`;
  if (!original.description) {
    changes.push(`Generated description: "${description}"`);
  }

  // Fix author - convert string to object
  let author: { name: string; email?: string };
  if (typeof original.author === 'string') {
    author = { name: original.author, email: 'plugins@metasheet.io' };
    changes.push(`Converted author string to object: ${original.author}`);
  } else if (original.author && typeof original.author === 'object') {
    author = original.author;
  } else {
    author = { name: 'MetaSheet Team', email: 'plugins@metasheet.io' };
    changes.push('Added default author: MetaSheet Team');
  }

  // Fix engine (not engines)
  let engine: { metasheet: string; node?: string };
  if (original.engine) {
    engine = original.engine;
  } else if (original.engines) {
    engine = {
      metasheet: original.engines.metasheet || '>=2.0.0',
      node: original.engines.node
    };
    changes.push('Converted engines → engine');
  } else {
    engine = { metasheet: '>=2.0.0', node: '>=18.0.0' };
    changes.push('Added default engine: { metasheet: ">=2.0.0" }');
  }

  // Fix main
  let main: string;
  if (typeof original.main === 'string') {
    main = original.main;
  } else if (original.main && typeof original.main === 'object') {
    main = original.main.backend || 'dist/index.js';
    changes.push(`Converted main object to string: ${main}`);
  } else {
    main = 'dist/index.js';
    changes.push('Added default main: "dist/index.js"');
  }

  // Fix capabilities - must be object with specific arrays
  let capabilities: FixedManifest['capabilities'] = {};
  if (!original.capabilities || typeof original.capabilities !== 'object') {
    capabilities = { views: [], workflows: [], functions: [] };
    changes.push('Added empty capabilities object');
  } else if (Array.isArray(original.capabilities)) {
    // Old format: array of strings
    capabilities = { views: original.capabilities, workflows: [], functions: [] };
    changes.push('Converted capabilities array to object');
  } else {
    // Check if it's in old format (boolean/string values)
    const oldCaps = original.capabilities;
    if (
      Object.values(oldCaps).some(
        (v) => typeof v === 'boolean' || typeof v === 'string'
      )
    ) {
      // Old format with booleans/strings
      capabilities = {
        views: oldCaps.views
          ? Array.isArray(oldCaps.views)
            ? oldCaps.views
            : []
          : [],
        workflows: oldCaps.workflows
          ? Array.isArray(oldCaps.workflows)
            ? oldCaps.workflows
            : []
          : [],
        functions: oldCaps.functions
          ? Array.isArray(oldCaps.functions)
            ? oldCaps.functions
            : []
          : []
      };
      changes.push('Normalized capabilities to standard format');
    } else {
      // Already in new format or empty
      capabilities = {
        views: Array.isArray(oldCaps.views) ? oldCaps.views : [],
        workflows: Array.isArray(oldCaps.workflows) ? oldCaps.workflows : [],
        functions: Array.isArray(oldCaps.functions) ? oldCaps.functions : []
      };
    }
  }

  // Fix permissions - convert array to object format
  let permissions: FixedManifest['permissions'] = {};
  if (Array.isArray(original.permissions)) {
    // Old format: ["database.read", "http.addRoute", ...]
    const perms = original.permissions as string[];
    permissions = {
      database: {
        read: perms.some((p) => p.includes('database.read')) ? ['*'] : undefined,
        write: perms.some((p) => p.includes('database.write'))
          ? ['*']
          : undefined
      },
      http: {
        internal: perms.some((p) => p.includes('http'))
      },
      filesystem: {
        read: perms.some((p) => p.includes('files.read')) ? ['*'] : undefined
      }
    };
    changes.push('Converted permissions array to object');
  } else if (original.permissions && typeof original.permissions === 'object') {
    // Check if it's already in the right format
    const oldPerms = original.permissions;
    if (oldPerms.apis || oldPerms.modules) {
      // Old format with apis/modules
      permissions = {
        database: { read: ['*'] },
        http: { internal: true }
      };
      changes.push('Converted old permissions format to standard');
    } else {
      permissions = oldPerms;
    }
  } else {
    permissions = {
      database: { read: ['*'] },
      http: { internal: true }
    };
    changes.push('Added default permissions');
  }

  // Build the fixed manifest
  const fixed: FixedManifest = {
    manifestVersion,
    name,
    version,
    displayName,
    description,
    author,
    engine,
    main,
    capabilities,
    permissions
  };

  // Preserve license
  if (original.license) {
    fixed.license = original.license;
  } else {
    fixed.license = 'MIT';
    changes.push('Added default license: MIT');
  }

  // Preserve repository if exists
  if (original.repository) {
    fixed.repository = original.repository;
  }

  // Preserve keywords if exists
  if (original.keywords) {
    fixed.keywords = original.keywords;
  }

  // Preserve homepage if exists
  if (original.homepage) {
    fixed.homepage = original.homepage;
  }

  // Log changes
  if (changes.length > 0) {
    console.log(`\n📝 ${filePath}:`);
    changes.forEach((change) => console.log(`   ✏️  ${change}`));
  }

  return fixed;
}

async function main() {
  console.log('🔧 Plugin Manifest Auto-Fix Tool\n');
  console.log('Scanning for plugin.json files...');

  const rootDir = path.resolve(process.cwd(), '../../');
  const pluginsDir = path.join(rootDir, 'plugins');

  // Get all plugin directories
  const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
  const pluginDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Find plugin.json files
  const files: string[] = [];
  for (const dir of pluginDirs) {
    const manifestPath = path.join(pluginsDir, dir, 'plugin.json');
    try {
      await fs.access(manifestPath);
      files.push(manifestPath);
    } catch {
      // No plugin.json in this directory
    }
  }

  console.log(`Found ${files.length} plugin manifests\n`);

  let fixedCount = 0;
  const errors: string[] = [];

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const original = JSON.parse(content) as OldManifest;

      const fixed = fixManifest(original, filePath);

      // Write the fixed manifest with pretty formatting
      await fs.writeFile(
        filePath,
        JSON.stringify(fixed, null, 2) + '\n',
        'utf-8'
      );

      fixedCount++;
    } catch (error) {
      const err = error as Error;
      errors.push(`${filePath}: ${err.message}`);
    }
  }

  console.log(`\n✅ Fixed ${fixedCount} manifests`);

  if (errors.length > 0) {
    console.log('\n❌ Errors:');
    errors.forEach((err) => console.log(`   ${err}`));
  }

  console.log('\n🏁 Done! Run the backend to verify all plugins load successfully.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
