-- 042c: Plugin manifests, dependencies and templates subset extracted from 042

-- Plugin manifests
CREATE TABLE IF NOT EXISTS plugin_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id VARCHAR(100) NOT NULL,
  version VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  author VARCHAR(255),
  homepage TEXT,
  repository JSONB,
  license VARCHAR(50),
  checksum VARCHAR(128),
  manifest JSONB NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_plugin_version UNIQUE (plugin_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_manifests_plugin ON plugin_manifests(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_manifests_version ON plugin_manifests(version);

-- Plugin dependencies
CREATE TABLE IF NOT EXISTS plugin_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id UUID NOT NULL REFERENCES plugin_manifests(id) ON DELETE CASCADE,
  depends_on_id UUID NOT NULL REFERENCES plugin_manifests(id) ON DELETE CASCADE,
  dependency_type VARCHAR(20) DEFAULT 'RUNTIME',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_plugin_dependency UNIQUE (plugin_id, depends_on_id),
  CONSTRAINT no_self_dependency CHECK (plugin_id != depends_on_id),
  CONSTRAINT valid_dependency_type CHECK (dependency_type IN ('RUNTIME','PEER','OPTIONAL','DEV'))
);

CREATE INDEX IF NOT EXISTS idx_plugin_dependencies_plugin ON plugin_dependencies(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_dependencies_depends ON plugin_dependencies(depends_on_id);

-- Templates
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  tags TEXT[],
  is_featured BOOLEAN DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP WITH TIME ZONE,
  template JSONB NOT NULL,
  template_type VARCHAR(50) DEFAULT 'TABLE',
  CONSTRAINT valid_template_type CHECK (template_type IN ('TABLE','WORKFLOW','VIEW','APP','PLUGIN','DASHBOARD'))
);

CREATE INDEX IF NOT EXISTS idx_templates_slug ON templates(slug);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_featured ON templates(is_featured) WHERE is_featured = TRUE;
CREATE INDEX IF NOT EXISTS idx_templates_published ON templates(published_at) WHERE published_at IS NOT NULL;

