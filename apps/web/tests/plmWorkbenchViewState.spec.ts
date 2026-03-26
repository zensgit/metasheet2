import { describe, expect, it } from 'vitest'
import {
  buildPlmWorkbenchResetHydratedPanelQueryPatch,
  buildPlmWorkbenchResetOwnerQueryPatch,
  buildPlmWorkbenchRoutePath,
  buildPlmWorkbenchTeamViewShareUrl,
  hasExplicitPlmBomTeamPresetAutoApplyQueryState,
  hasExplicitPlmApprovalsAutoApplyQueryState,
  hasExplicitPlmCadAutoApplyQueryState,
  hasExplicitPlmDocumentAutoApplyQueryState,
  hasExplicitPlmWorkbenchAutoApplyQueryState,
  hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState,
  matchPlmWorkbenchQuerySnapshot,
  mergePlmWorkbenchRouteQuery,
  normalizePlmWorkbenchCollaborativeQuerySnapshot,
  normalizePlmWorkbenchPanelScope,
  normalizePlmWorkbenchQuerySnapshot,
} from '../src/views/plm/plmWorkbenchViewState'
import { applyPlmDeferredRouteQueryPatch } from '../src/views/plm/plmRouteHydrationPatch'

describe('plmWorkbenchViewState', () => {
  it('normalizes only supported workbench query keys', () => {
    expect(
      normalizePlmWorkbenchQuerySnapshot({
        workbenchTeamView: ' view-1 ',
        bomFilterPreset: ' bom-local-1 ',
        whereUsedFilterPreset: ' where-local-1 ',
        productId: 'prod-100',
        documentFilter: ' gear ',
        approvalsFilter: 'eco',
        autoload: true,
        ignored: 'value',
      }),
    ).toEqual({
      workbenchTeamView: 'view-1',
      bomFilterPreset: 'bom-local-1',
      whereUsedFilterPreset: 'where-local-1',
      productId: 'prod-100',
      documentFilter: 'gear',
      approvalsFilter: 'eco',
      autoload: 'true',
    })
  })

  it('replaces PLM query keys while preserving non-PLM query state', () => {
    expect(
      mergePlmWorkbenchRouteQuery(
        {
          searchQuery: 'motor',
          productId: 'prod-old',
          tab: 'details',
        },
        {
          workbenchTeamView: 'view-1',
          bomFilterPreset: 'bom-local-1',
          whereUsedFilterPreset: 'where-local-1',
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      ),
    ).toEqual({
      tab: 'details',
      workbenchTeamView: 'view-1',
      bomFilterPreset: 'bom-local-1',
      whereUsedFilterPreset: 'where-local-1',
      productId: 'prod-100',
      documentFilter: 'gear',
      approvalsFilter: 'eco',
    })
  })

  it('matches workbench snapshots while ignoring explicit team-view identity', () => {
    expect(
      matchPlmWorkbenchQuerySnapshot(
        {
          workbenchTeamView: 'view-1',
          productId: 'prod-100',
          documentFilter: ' gear ',
          approvalsFilter: 'eco',
        },
        {
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
      ),
    ).toBe(true)
  })

  it('normalizes collaborative workbench snapshots without local preset ownership', () => {
    expect(
      normalizePlmWorkbenchCollaborativeQuerySnapshot({
        workbenchTeamView: 'view-1',
        panel: ' approvals, documents, approvals ',
        bomFilterPreset: 'bom-local-1',
        whereUsedFilterPreset: 'where-local-1',
        approvalComment: 'ship-it',
        bomFilter: 'gear',
        bomFilterField: 'path',
        whereUsedFilter: 'assy',
      }),
    ).toEqual({
      panel: 'documents,approvals',
      bomFilter: 'gear',
      bomFilterField: 'path',
      whereUsedFilter: 'assy',
    })
  })

  it('normalizes explicit panel scope to canonical collaborative order', () => {
    expect(normalizePlmWorkbenchPanelScope(' approvals, documents, approvals ')).toBe('documents,approvals')
    expect(normalizePlmWorkbenchPanelScope('all')).toBeUndefined()
    expect(normalizePlmWorkbenchPanelScope('unknown')).toBeUndefined()
  })

  it('builds a reset patch that clears every canonical panel team-view owner', () => {
    expect(buildPlmWorkbenchResetOwnerQueryPatch()).toEqual({
      workbenchTeamView: '',
      documentTeamView: '',
      cadTeamView: '',
      approvalsTeamView: '',
    })
  })

  it('builds a reset patch that clears hydrated panel query state', () => {
    expect(buildPlmWorkbenchResetHydratedPanelQueryPatch()).toEqual({
      workbenchTeamView: '',
      documentTeamView: '',
      cadTeamView: '',
      approvalsTeamView: '',
      documentSort: '',
      documentSortDir: '',
      documentColumns: '',
      cadReviewState: '',
      cadReviewNote: '',
      approvalComment: '',
      approvalSort: '',
      approvalSortDir: '',
      approvalColumns: '',
    })
  })

  it('detects workbench snapshot drift after manual query edits', () => {
    expect(
      matchPlmWorkbenchQuerySnapshot(
        {
          workbenchTeamView: 'view-1',
          productId: 'prod-100',
          documentFilter: 'gear',
          approvalsFilter: 'eco',
        },
        {
          productId: 'prod-100',
          documentFilter: 'motor',
          approvalsFilter: 'eco',
        },
      ),
    ).toBe(false)
  })

  it('matches workbench snapshots even when one side still carries local preset ids', () => {
    expect(
      matchPlmWorkbenchQuerySnapshot(
        {
          workbenchTeamView: 'view-1',
          bomFilterPreset: 'bom-local-1',
          whereUsedFilterPreset: 'where-local-1',
          bomFilter: 'gear',
          bomFilterField: 'path',
          whereUsedFilter: 'assy',
        },
        {
          bomFilter: 'gear',
          bomFilterField: 'path',
          whereUsedFilter: 'assy',
        },
      ),
    ).toBe(true)
  })

  it('matches workbench snapshots even when explicit panel order differs', () => {
    expect(
      matchPlmWorkbenchQuerySnapshot(
        {
          workbenchTeamView: 'view-1',
          panel: 'approvals,documents',
          bomFilter: 'gear',
        },
        {
          panel: 'documents,approvals',
          bomFilter: 'gear',
        },
      ),
    ).toBe(true)
  })

  it('matches workbench snapshots even when only approval comments differ', () => {
    expect(
      matchPlmWorkbenchQuerySnapshot(
        {
          workbenchTeamView: 'view-1',
          approvalsFilter: 'eco',
          approvalComment: 'ship-it',
        },
        {
          approvalsFilter: 'eco',
          approvalComment: 'needs-review',
        },
      ),
    ).toBe(true)
  })

  it('does not treat approval comments as explicit workbench auto-apply blockers', () => {
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        approvalComment: 'draft-note',
      }),
    ).toBe(false)
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        approvalComment: 'draft-note',
        approvalsFilter: 'pending',
      }),
    ).toBe(true)
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        workbenchTeamView: 'view-1',
      }),
    ).toBe(true)
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        panel: 'all',
      }),
    ).toBe(false)
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        panel: 'unknown',
      }),
    ).toBe(false)
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        panel: 'approvals,documents',
      }),
    ).toBe(true)
  })

  it('does not treat approval comments as explicit approvals auto-apply blockers', () => {
    const defaultColumns = {
      status: true,
      type: true,
      requester: true,
      created: true,
      product: true,
      actions: true,
    }

    expect(
      hasExplicitPlmApprovalsAutoApplyQueryState({
        approvalComment: 'draft-note',
      }, defaultColumns),
    ).toBe(false)
    expect(
      hasExplicitPlmApprovalsAutoApplyQueryState({
        approvalComment: 'draft-note',
        approvalsFilter: 'pending',
      }, defaultColumns),
    ).toBe(true)
    expect(
      hasExplicitPlmApprovalsAutoApplyQueryState({
        approvalsTeamView: 'approvals-view-1',
      }, defaultColumns),
    ).toBe(true)
  })

  it('ignores explicit default workbench query values when deciding workbench default auto-apply blockers', () => {
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        searchItemType: 'Part',
        searchLimit: '10',
        itemType: 'Part',
        whereUsedRecursive: 'true',
        whereUsedMaxLevels: '5',
        bomDepth: '2',
        bomView: 'table',
        compareLineKey: 'child_config',
        compareMaxLevels: '10',
        compareIncludeChildFields: 'true',
        compareIncludeSubstitutes: 'false',
        compareIncludeEffectivity: 'false',
        compareSync: 'true',
        compareRelationshipProps: 'quantity,uom,find_num,refdes',
      }),
    ).toBe(false)

    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        compareSync: 'false',
      }),
    ).toBe(true)

    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        bomView: 'tree',
      }),
    ).toBe(true)
  })

  it('ignores explicit default approvals query values when deciding approvals default auto-apply blockers', () => {
    const defaultColumns = {
      status: true,
      type: true,
      requester: true,
      created: true,
      product: true,
      actions: true,
    }

    expect(
      hasExplicitPlmApprovalsAutoApplyQueryState(
        {
          approvalsStatus: 'pending',
          approvalSort: 'created',
          approvalSortDir: 'desc',
          approvalColumns: 'status,type,requester,created,product,actions',
        },
        defaultColumns,
      ),
    ).toBe(false)

    expect(
      hasExplicitPlmApprovalsAutoApplyQueryState(
        {
          approvalsStatus: 'approved',
        },
        defaultColumns,
      ),
    ).toBe(true)
  })

  it('ignores explicit default document query values when deciding document default auto-apply blockers', () => {
    const defaultColumns = {
      title: true,
      type: true,
      revision: true,
      role: true,
      size: true,
    }

    expect(
      hasExplicitPlmDocumentAutoApplyQueryState(
        {
          documentSort: 'updated',
          documentSortDir: 'desc',
          documentColumns: 'title,type,revision,role,size',
        },
        defaultColumns,
      ),
    ).toBe(false)

    expect(
      hasExplicitPlmDocumentAutoApplyQueryState(
        {
          documentSort: 'name',
        },
        defaultColumns,
      ),
    ).toBe(true)
  })

  it('ignores explicit empty CAD query values when deciding CAD default auto-apply blockers', () => {
    expect(
      hasExplicitPlmCadAutoApplyQueryState({
        cadReviewState: '',
        cadReviewNote: '   ',
      }),
    ).toBe(false)

    expect(
      hasExplicitPlmCadAutoApplyQueryState({
        cadFileId: 'cad-001',
      }),
    ).toBe(true)
  })

  it('treats deferred document blockers with non-default state as explicit document auto-apply blockers', () => {
    const defaultColumns = {
      title: true,
      type: true,
      revision: true,
      role: true,
      size: true,
    }

    expect(
      hasExplicitPlmDocumentAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          {
            documentSort: 'updated',
            documentSortDir: 'desc',
          },
        ),
        defaultColumns,
      ),
    ).toBe(false)

    expect(
      hasExplicitPlmDocumentAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          {
            documentFilter: 'gear',
          },
        ),
        defaultColumns,
      ),
    ).toBe(true)
  })

  it('treats deferred CAD blockers with non-default state as explicit CAD auto-apply blockers', () => {
    expect(
      hasExplicitPlmCadAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          {
            cadReviewState: '',
            cadReviewNote: '   ',
          },
        ),
      ),
    ).toBe(false)

    expect(
      hasExplicitPlmCadAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          {
            cadReviewState: 'approved',
          },
        ),
      ),
    ).toBe(true)
  })

  it('treats deferred BOM preset blockers as explicit default auto-apply blockers', () => {
    expect(
      hasExplicitPlmBomTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          { bomFilterPreset: 'bom-local-1' },
        ),
      ),
    ).toBe(true)

    expect(
      hasExplicitPlmBomTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          { bomFilterPreset: 'bom-local-1' },
          { bomFilterPreset: undefined },
        ),
      ),
    ).toBe(false)

    expect(
      hasExplicitPlmBomTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          { bomFilterField: 'all' },
        ),
      ),
    ).toBe(false)
  })

  it('treats deferred Where-Used preset blockers as explicit default auto-apply blockers', () => {
    expect(
      hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          { whereUsedFilterField: 'parent', whereUsedFilter: 'assy-01' },
        ),
      ),
    ).toBe(true)

    expect(
      hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          { whereUsedFilterField: 'parent', whereUsedFilter: 'assy-01' },
          { whereUsedFilterField: '', whereUsedFilter: undefined },
        ),
      ),
    ).toBe(false)

    expect(
      hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          { whereUsedFilterField: 'all' },
        ),
      ),
    ).toBe(false)
  })

  it('builds a workbench team view share URL that preserves explicit identity and normalized query state', () => {
    expect(
      buildPlmWorkbenchTeamViewShareUrl(
        'workbench',
        {
          id: 'workbench-view-1',
          kind: 'workbench',
          scope: 'team',
          name: '工作台视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              workbenchTeamView: 'stale-view',
              bomFilterPreset: 'bom-local-1',
              whereUsedFilterPreset: 'where-local-1',
              bomFilter: 'gear',
              bomFilterField: 'path',
              panel: ' approvals, documents ',
              documentFilter: ' gear ',
              approvalsFilter: 'eco',
              approvalComment: 'ship-it',
              ignored: 'value',
            },
          },
        },
        '/plm',
        'https://example.test',
      ),
    ).toBe(
      'https://example.test/plm?workbenchTeamView=workbench-view-1&bomFilter=gear&bomFilterField=path&panel=documents%2Capprovals&documentFilter=gear&approvalsFilter=eco',
    )
  })

  it('builds panel team view share URLs with explicit team-view identity', () => {
    const documentsUrl = buildPlmWorkbenchTeamViewShareUrl(
      'documents',
      {
        id: 'document-view-1',
        kind: 'documents',
        scope: 'team',
        name: '文档视角',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: {
          role: 'primary',
          filter: 'gear',
          sortKey: 'name',
          sortDir: 'asc',
          columns: {
            mime: true,
            actions: false,
          },
        },
      },
      '/plm',
      'https://example.test',
    )
    const cadUrl = buildPlmWorkbenchTeamViewShareUrl(
      'cad',
      {
        id: 'cad-view-1',
        kind: 'cad',
        scope: 'team',
        name: 'CAD 视角',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: {
          fileId: 'file-main',
          otherFileId: 'file-other',
          reviewState: 'approved',
          reviewNote: 'looks-good',
        },
      },
      '/plm',
      'https://example.test',
    )
    const approvalsUrl = buildPlmWorkbenchTeamViewShareUrl(
      'approvals',
      {
        id: 'approval-view-1',
        kind: 'approvals',
        scope: 'team',
        name: '审批视角',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: {
          status: 'approved',
          filter: 'eco',
          sortKey: 'title',
          sortDir: 'asc',
          columns: {
            product: true,
            actions: false,
          },
        },
      },
      '/plm',
      'https://example.test',
    )

    expect(documentsUrl).toBe(
      'https://example.test/plm?panel=documents&documentTeamView=document-view-1&documentRole=primary&documentFilter=gear&documentSort=name&documentSortDir=asc&documentColumns=mime',
    )
    expect(cadUrl).toBe(
      'https://example.test/plm?panel=cad&cadTeamView=cad-view-1&cadFileId=file-main&cadOtherFileId=file-other&cadReviewState=approved&cadReviewNote=looks-good',
    )
    expect(approvalsUrl).toBe(
      'https://example.test/plm?panel=approvals&approvalsTeamView=approval-view-1&approvalsStatus=approved&approvalsFilter=eco&approvalSort=title&approvalSortDir=asc&approvalColumns=product',
    )
  })

  it('builds return paths from the current local workbench state with optional overlays', () => {
    expect(buildPlmWorkbenchRoutePath(
      '/plm',
      {
        workbenchTeamView: ' workbench-view-1 ',
        searchQuery: 'gear',
        panel: ' approvals, documents ',
        bomFilterPreset: 'bom-local-1',
        bomFilter: 'assy',
        bomFilterField: 'path',
        whereUsedFilterPreset: 'where-local-1',
        whereUsedFilter: 'motor',
        approvalsFilter: 'eco',
        approvalComment: 'ship-it',
        autoload: true,
      },
      {
        hash: '#audit',
        extraQuery: {
          sceneFocus: 'scene-1',
        },
      },
    )).toBe('/plm?workbenchTeamView=workbench-view-1&searchQuery=gear&panel=documents%2Capprovals&bomFilter=assy&bomFilterField=path&whereUsedFilter=motor&approvalsFilter=eco&autoload=true&sceneFocus=scene-1#audit')
  })

  it('builds audit team view share URLs with explicit team-view identity', () => {
    expect(
      buildPlmWorkbenchTeamViewShareUrl(
        'audit',
        {
          id: 'audit-view-1',
          kind: 'audit',
          scope: 'team',
          name: '审计视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            page: 2,
            q: 'documents',
            actorId: 'dev-user',
            kind: 'documents',
            action: 'archive',
            resourceType: 'plm-team-view-batch',
            from: '2026-03-11T15:00:00.000Z',
            to: '2026-03-11T16:00:00.000Z',
            windowMinutes: 720,
          },
        },
        '/plm/audit',
        'https://example.test',
      ),
    ).toBe(
      'https://example.test/plm/audit?auditEntry=share&auditPage=2&auditQ=documents&auditActor=dev-user&auditKind=documents&auditAction=archive&auditType=plm-team-view-batch&auditFrom=2026-03-11T15%3A00%3A00.000Z&auditTo=2026-03-11T16%3A00%3A00.000Z&auditWindow=720&auditTeamView=audit-view-1',
    )
  })
})
