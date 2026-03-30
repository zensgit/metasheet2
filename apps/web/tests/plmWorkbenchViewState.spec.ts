import { describe, expect, it } from 'vitest'
import {
  buildPlmWorkbenchLegacyLocalDraftQueryPatch,
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
  normalizePlmWorkbenchLocalRouteQuerySnapshot,
  normalizePlmWorkbenchPanelScope,
  normalizePlmWorkbenchQuerySnapshot,
  shouldAutoloadPlmProductContext,
  shouldAutoloadPlmWorkbenchSnapshot,
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

  it('matches workbench snapshots while ignoring autoload-only differences', () => {
    expect(
      matchPlmWorkbenchQuerySnapshot(
        {
          productId: 'prod-100',
          documentFilter: 'gear',
          autoload: true,
        },
        {
          productId: 'prod-100',
          documentFilter: 'gear',
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

  it('drops field-only BOM and Where-Used filter state from canonical snapshots', () => {
    expect(
      normalizePlmWorkbenchCollaborativeQuerySnapshot({
        workbenchTeamView: 'view-1',
        bomFilterField: 'path',
        whereUsedFilterField: 'parent',
      }),
    ).toEqual({})

    expect(
      normalizePlmWorkbenchLocalRouteQuerySnapshot({
        workbenchTeamView: ' workbench-view-1 ',
        bomFilterField: 'path',
        whereUsedFilterField: 'parent',
        approvalComment: 'ship-it',
      }),
    ).toEqual({
      workbenchTeamView: 'workbench-view-1',
    })
  })

  it('normalizes local route snapshots without approval draft leakage', () => {
    expect(
      normalizePlmWorkbenchLocalRouteQuerySnapshot({
        workbenchTeamView: ' workbench-view-1 ',
        bomFilterPreset: 'bom-local-1',
        whereUsedFilterPreset: 'where-local-1',
        approvalsFilter: ' eco ',
        approvalComment: 'ship-it',
        panel: ' approvals, documents ',
      }),
    ).toEqual({
      workbenchTeamView: 'workbench-view-1',
      bomFilterPreset: 'bom-local-1',
      whereUsedFilterPreset: 'where-local-1',
      approvalsFilter: 'eco',
      panel: 'documents,approvals',
    })
  })

  it('ignores legacy approval drafts in canonical query snapshots', () => {
    expect(
      normalizePlmWorkbenchQuerySnapshot({
        approvalsFilter: ' eco ',
        approvalComment: 'ship-it',
      }),
    ).toEqual({
      approvalsFilter: 'eco',
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

  it('builds a cleanup patch for legacy local approval draft query state', () => {
    expect(
      buildPlmWorkbenchLegacyLocalDraftQueryPatch({
        approvalsFilter: 'eco',
        approvalComment: 'ship-it',
      }),
    ).toEqual({
      approvalComment: '',
    })
    expect(
      buildPlmWorkbenchLegacyLocalDraftQueryPatch({
        approvalsFilter: 'eco',
      }),
    ).toEqual({})
    expect(
      buildPlmWorkbenchLegacyLocalDraftQueryPatch({
        approvalComment: ['ship-it'],
      }),
    ).toEqual({
      approvalComment: '',
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
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        autoload: 'true',
      }),
    ).toBe(false)
    expect(
      hasExplicitPlmWorkbenchAutoApplyQueryState({
        autoload: 'false',
      }),
    ).toBe(false)
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
          {},
          { bomFilterPreset: 'bom-missing' },
        ),
        { hasLocalFilterPresetOwner: false },
      ),
    ).toBe(false)

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

    expect(
      hasExplicitPlmBomTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          { bomFilterField: 'path' },
        ),
      ),
    ).toBe(false)

    const bomShouldAutoApplyDefault = !hasExplicitPlmBomTeamPresetAutoApplyQueryState(
      applyPlmDeferredRouteQueryPatch(
        {},
        { bomFilterField: 'path' },
      ),
    ) && !''.trim()
    expect(bomShouldAutoApplyDefault).toBe(true)
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
          {},
          { whereUsedFilterPreset: 'where-missing' },
        ),
        { hasLocalFilterPresetOwner: false },
      ),
    ).toBe(false)

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

    expect(
      hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(
        applyPlmDeferredRouteQueryPatch(
          {},
          { whereUsedFilterField: 'parent' },
        ),
      ),
    ).toBe(false)

    const whereUsedShouldAutoApplyDefault = !hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(
      applyPlmDeferredRouteQueryPatch(
        {},
        { whereUsedFilterField: 'parent' },
      ),
    ) && !''.trim()
    expect(whereUsedShouldAutoApplyDefault).toBe(true)
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
              whereUsedFilterField: 'parent',
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

  it('adds autoload to workbench team view share URLs when the saved snapshot carries product bootstrap context', () => {
    expect(
      buildPlmWorkbenchTeamViewShareUrl(
        'workbench',
        {
          id: 'workbench-view-2',
          kind: 'workbench',
          scope: 'team',
          name: '产品联动场景',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              panel: 'documents,approvals',
              productId: 'product-42',
              itemNumber: 'P-1001',
              itemType: 'Assembly',
              documentFilter: 'spec',
            },
          },
        },
        '/plm',
        'https://example.test',
      ),
    ).toBe(
      'https://example.test/plm?workbenchTeamView=workbench-view-2&panel=documents%2Capprovals&productId=product-42&itemNumber=P-1001&itemType=Assembly&documentFilter=spec&autoload=true',
    )
  })

  it('adds autoload to workbench team view share URLs when the saved snapshot targets cad directly', () => {
    expect(
      buildPlmWorkbenchTeamViewShareUrl(
        'workbench',
        {
          id: 'workbench-view-3',
          kind: 'workbench',
          scope: 'team',
          name: 'CAD 场景',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              panel: 'cad',
              cadFileId: 'cad-main',
            },
          },
        },
        '/plm',
        'https://example.test',
      ),
    ).toBe(
      'https://example.test/plm?workbenchTeamView=workbench-view-3&panel=cad&cadFileId=cad-main&autoload=true',
    )
  })

  it('does not leak a stale autoload flag from saved view query into workbench share URLs', () => {
    expect(
      buildPlmWorkbenchTeamViewShareUrl(
        'workbench',
        {
          id: 'workbench-view-stale',
          kind: 'workbench',
          scope: 'team',
          name: '过时自动加载场景',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            query: {
              bomFilter: 'gear',
              bomFilterField: 'path',
              autoload: 'true',
            },
          },
        },
        '/plm',
        'https://example.test',
      ),
    ).toBe(
      'https://example.test/plm?workbenchTeamView=workbench-view-stale&bomFilter=gear&bomFilterField=path',
    )
  })

  it('uses the current runtime origin when team-view share urls do not receive an explicit origin', () => {
    const url = new URL(
      buildPlmWorkbenchTeamViewShareUrl(
        'audit',
        {
          id: 'audit-view-runtime',
          kind: 'audit',
          scope: 'team',
          name: '审计视角',
          ownerUserId: 'dev-user',
          canManage: true,
          isDefault: false,
          state: {
            q: 'gear',
          },
        },
        '/plm',
      ),
    )

    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/plm')
    expect(url.searchParams.get('auditEntry')).toBe('share')
    expect(url.searchParams.get('auditTeamView')).toBe('audit-view-runtime')
    expect(url.searchParams.get('auditQ')).toBe('gear')
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
      'https://example.test/plm?panel=cad&cadTeamView=cad-view-1&cadFileId=file-main&cadOtherFileId=file-other&cadReviewState=approved&cadReviewNote=looks-good&autoload=true',
    )
    expect(approvalsUrl).toBe(
      'https://example.test/plm?panel=approvals&approvalsTeamView=approval-view-1&approvalsStatus=approved&approvalsFilter=eco&approvalSort=title&approvalSortDir=asc&approvalColumns=product',
    )
  })

  it('adds autoload to CAD team-view share urls when a primary CAD file is present', () => {
    expect(buildPlmWorkbenchTeamViewShareUrl(
      'cad',
      {
        id: 'cad-view-2',
        kind: 'cad',
        scope: 'team',
        name: 'CAD 单文件视角',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: {
          fileId: 'file-main',
          otherFileId: '',
          reviewState: '',
          reviewNote: '',
        },
      },
      '/plm',
      'https://example.test',
    )).toBe(
      'https://example.test/plm?panel=cad&cadTeamView=cad-view-2&cadFileId=file-main&autoload=true',
    )
  })

  it('adds product context and autoload to document team-view share urls when a product is selected', () => {
    expect(buildPlmWorkbenchTeamViewShareUrl(
      'documents',
      {
        id: 'document-view-2',
        kind: 'documents',
        scope: 'team',
        name: '文档视角',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: {
          role: 'secondary',
          filter: 'spec',
          sortKey: 'updated',
          sortDir: 'desc',
          columns: {
            actions: false,
          },
        },
      },
      '/plm',
      'https://example.test',
      {
        productId: 'product-42',
      },
    )).toBe(
      'https://example.test/plm?panel=documents&documentTeamView=document-view-2&productId=product-42&documentRole=secondary&documentFilter=spec&autoload=true',
    )
  })

  it('adds item identity and autoload to approvals team-view share urls when only item-number context is available', () => {
    expect(buildPlmWorkbenchTeamViewShareUrl(
      'approvals',
      {
        id: 'approval-view-2',
        kind: 'approvals',
        scope: 'team',
        name: '审批视角',
        ownerUserId: 'dev-user',
        canManage: true,
        isDefault: false,
        state: {
          status: 'pending',
          filter: '',
          sortKey: 'created',
          sortDir: 'desc',
          columns: {
            product: true,
            actions: false,
          },
        },
      },
      '/plm',
      'https://example.test',
      {
        itemNumber: 'P-1001',
        itemType: 'Assembly',
      },
    )).toBe(
      'https://example.test/plm?panel=approvals&approvalsTeamView=approval-view-2&itemNumber=P-1001&itemType=Assembly&approvalColumns=product&autoload=true',
    )
  })

  it('bootstraps product context for item-number-only document and approval autoload routes', () => {
    expect(shouldAutoloadPlmProductContext({
      panel: 'documents',
      itemNumber: 'P-1001',
    })).toBe(true)
    expect(shouldAutoloadPlmProductContext({
      panel: 'approvals',
      itemNumber: 'P-1001',
    })).toBe(true)
  })

  it('bootstraps product context for product-adjacent panels but keeps cad excluded', () => {
    expect(shouldAutoloadPlmProductContext({
      panel: 'cad',
      itemNumber: 'P-1001',
    })).toBe(false)
    expect(shouldAutoloadPlmProductContext({
      panel: 'compare',
      productId: 'product-42',
    })).toBe(true)
    expect(shouldAutoloadPlmProductContext({
      panel: 'where-used',
      itemNumber: 'P-1001',
    })).toBe(true)
    expect(shouldAutoloadPlmProductContext({
      panel: 'substitutes',
      productId: 'product-42',
    })).toBe(true)
  })

  it('treats missing panel scope as an all-panels bootstrap when product identity exists', () => {
    expect(shouldAutoloadPlmProductContext({
      itemNumber: 'P-1001',
    })).toBe(true)
  })

  it('respects panel scope when deriving autoload for workbench snapshot return paths', () => {
    // panel=cad with product context should NOT autoload (cad is not product-adjacent)
    expect(shouldAutoloadPlmWorkbenchSnapshot({
      panel: 'cad',
      cadFileId: 'cad-main',
      productId: 'product-42',
    })).toBe(true) // cadFileId triggers autoload — product context is irrelevant

    expect(shouldAutoloadPlmWorkbenchSnapshot({
      panel: 'cad',
      productId: 'product-42',
    })).toBe(false) // no cadFileId, cad panel excludes product autoload

    // panel=documents with product context SHOULD autoload
    expect(shouldAutoloadPlmWorkbenchSnapshot({
      panel: 'documents',
      productId: 'product-42',
    })).toBe(true)

    // no panel with product context should autoload (all-panels default)
    expect(shouldAutoloadPlmWorkbenchSnapshot({
      productId: 'product-42',
    })).toBe(true)

    // panel=cad with only product identity and no cadFileId: no autoload
    expect(shouldAutoloadPlmWorkbenchSnapshot({
      panel: 'cad',
      itemNumber: 'P-1001',
    })).toBe(false)
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

  it('omits field-only filter state from return paths', () => {
    expect(buildPlmWorkbenchRoutePath(
      '/plm',
      {
        workbenchTeamView: ' workbench-view-1 ',
        panel: ' product ',
        bomFilterField: 'path',
        whereUsedFilterField: 'parent',
      },
    )).toBe('/plm?workbenchTeamView=workbench-view-1&panel=product')
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
