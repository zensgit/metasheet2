import { describe, expect, it } from 'vitest'
import {
  buildPlmWorkbenchTeamViewShareUrl,
  mergePlmWorkbenchRouteQuery,
  normalizePlmWorkbenchQuerySnapshot,
} from '../src/views/plm/plmWorkbenchViewState'

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
              documentFilter: ' gear ',
              approvalsFilter: 'eco',
              ignored: 'value',
            },
          },
        },
        '/plm',
        'https://example.test',
      ),
    ).toBe(
      'https://example.test/plm?workbenchTeamView=workbench-view-1&documentFilter=gear&approvalsFilter=eco',
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
          comment: 'ship-it',
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
      'https://example.test/plm?panel=approvals&approvalsTeamView=approval-view-1&approvalsStatus=approved&approvalsFilter=eco&approvalComment=ship-it&approvalSort=title&approvalSortDir=asc&approvalColumns=product',
    )
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
