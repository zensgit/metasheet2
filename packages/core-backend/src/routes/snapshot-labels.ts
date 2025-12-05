/**
 * Snapshot Labels API Routes
 * Sprint 2: Snapshot Protection System
 *
 * Provides REST API for snapshot labeling operations
 */

import { Router } from 'express';
import { snapshotService } from '../services/SnapshotService';
import { Logger } from '../core/logger';

const router = Router();
const logger = new Logger('SnapshotLabelsRoutes');

// Type for protection levels
type ProtectionLevel = 'normal' | 'protected' | 'critical';

// Type for release channels
type ReleaseChannel = 'stable' | 'canary' | 'beta' | 'experimental';

/**
 * PUT /api/snapshots/:id/tags
 * Add or remove tags from a snapshot
 */
router.put('/:id/tags', async (req, res) => {
  try {
    const { id } = req.params;
    const { add, remove } = req.body;
    const userId = req.headers['x-user-id'] as string || 'system';

    if (add && Array.isArray(add) && add.length > 0) {
      await snapshotService.addTags(id, add, userId);
    }

    if (remove && Array.isArray(remove) && remove.length > 0) {
      await snapshotService.removeTags(id, remove, userId);
    }

    const snapshot = await snapshotService.getSnapshot(id);

    res.json({
      success: true,
      snapshot,
      message: 'Tags updated successfully'
    });
  } catch (error) {
    logger.error('Failed to update tags', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * PATCH /api/snapshots/:id/protection
 * Set protection level for a snapshot
 */
router.patch('/:id/protection', async (req, res) => {
  try {
    const { id } = req.params;
    const { level } = req.body;
    const userId = req.headers['x-user-id'] as string || 'system';

    if (!level || !['normal', 'protected', 'critical'].includes(level)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid protection level. Must be: normal, protected, or critical'
      });
    }

    await snapshotService.setProtectionLevel(id, level, userId);

    const snapshot = await snapshotService.getSnapshot(id);

    res.json({
      success: true,
      snapshot,
      message: `Protection level set to: ${level}`
    });
  } catch (error) {
    logger.error('Failed to set protection level', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * PATCH /api/snapshots/:id/release-channel
 * Set release channel for a snapshot
 */
router.patch('/:id/release-channel', async (req, res) => {
  try {
    const { id } = req.params;
    const { channel } = req.body;
    const userId = req.headers['x-user-id'] as string || 'system';

    if (channel && !['stable', 'canary', 'beta', 'experimental'].includes(channel)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid release channel. Must be: stable, canary, beta, or experimental'
      });
    }

    await snapshotService.setReleaseChannel(id, channel, userId);

    const snapshot = await snapshotService.getSnapshot(id);

    res.json({
      success: true,
      snapshot,
      message: `Release channel set to: ${channel || 'none'}`
    });
  } catch (error) {
    logger.error('Failed to set release channel', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * GET /api/snapshots
 * Query snapshots with optional filters
 * Supports filtering by: tags, protection_level, release_channel
 */
router.get('/', async (req, res) => {
  try {
    const { tags, protection_level, release_channel } = req.query;

    let snapshots;

    if (tags) {
      // Query by tags (comma-separated)
      const tagArray = (tags as string).split(',').map(t => t.trim());
      snapshots = await snapshotService.getByTags(tagArray);
    } else if (protection_level) {
      // Query by protection level
      if (!['normal', 'protected', 'critical'].includes(protection_level as string)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid protection level'
        });
      }
      snapshots = await snapshotService.getByProtectionLevel(protection_level as ProtectionLevel);
    } else if (release_channel) {
      // Query by release channel
      if (!['stable', 'canary', 'beta', 'experimental'].includes(release_channel as string)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid release channel'
        });
      }
      snapshots = await snapshotService.getByReleaseChannel(release_channel as ReleaseChannel);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Please specify at least one filter: tags, protection_level, or release_channel'
      });
    }

    res.json({
      success: true,
      snapshots,
      count: snapshots.length
    });
  } catch (error) {
    logger.error('Failed to query snapshots', error as Error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

export default router;
