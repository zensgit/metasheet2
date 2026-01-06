# PLM Federation Integration Verification

Date: 2026-01-06 15:11:36

## Environment
- Core backend: http://127.0.0.1:7778
- PLM backend: http://127.0.0.1:7910
- PLM API mode: yuantus
- Tenant/Org: tenant-1 / org-1
- Parent item id: d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a
- Child item id: fdd72a36-be6e-4967-b697-13069e93f59f
- BOM line id: 027384a6-aea1-4b54-ae1b-0ada996ab9ca

## Results

- products: OK (total=550, sample_ids=['a338fc4f-bcc6-43b6-971d-a5e3c2a08e6b', '4a826410-120b-40b3-8e8a-b246f56fdb05', 'e2f6714b-1e95-4319-8da1-c1a12729468b'])
- product_detail: OK (id=d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a)
- bom: OK (total=1, sample_line_id=027384a6-aea1-4b54-ae1b-0ada996ab9ca)
- documents: OK (total=0)
- approvals: OK (total=20)
- where_used: OK (count=1)
- bom_compare: OK (summary={'added': 0, 'removed': 1, 'changed': 0, 'changed_major': 0, 'changed_minor': 0, 'changed_info': 0})
- substitutes: OK (count=0)

## Raw Samples

### products
```json
{
  "data": [
    {
      "id": "a338fc4f-bcc6-43b6-971d-a5e3c2a08e6b",
      "name": "Tenant A Org A Part",
      "code": "MT-A1-1767490184",
      "version": "",
      "status": "Draft",
      "created_at": "2026-01-04T01:29:46",
      "updated_at": "2026-01-04T01:29:46"
    },
    {
      "id": "4a826410-120b-40b3-8e8a-b246f56fdb05",
      "name": "\u6d69\u8fb0CAD\u96f6\u4ef6",
      "code": "HC-1767490220",
      "version": "A",
      "status": "Draft",
      "description": "\u6d69\u8fb0CAD\u96f6\u4ef6",
      "created_at": "2026-01-04T01:30:21",
      "updated_at": "2026-01-04T01:30:21"
    },
    {
      "id": "e2f6714b-1e95-4319-8da1-c1a12729468b",
      "name": "Tenant A Org A Part",
      "code": "MT-A1-1767490436",
      "version": "",
      "status": "Draft",
      "created_at": "2026-01-04T01:33:58",
      "updated_at": "2026-01-04T01:33:58"
    }
  ],
  "total": 550,
  "limit": 3,
  "offset": 0
}
```

### product_detail
```json
{
  "data": {
    "id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
    "name": "Part A (Test)",
    "code": "P-BOM-A-1767683231",
    "version": "",
    "status": "Draft",
    "itemType": "Part",
    "properties": {
      "item_number": "P-BOM-A-1767683231",
      "name": "Part A (Test)",
      "state": "Draft"
    },
    "created_at": "2026-01-06T07:07:11",
    "updated_at": "2026-01-06T07:07:11"
  }
}
```

### bom
```json
{
  "data": [
    {
      "id": "027384a6-aea1-4b54-ae1b-0ada996ab9ca",
      "product_id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
      "parent_item_id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
      "component_id": "fdd72a36-be6e-4967-b697-13069e93f59f",
      "component_name": "Part B (Child)",
      "component_code": "P-BOM-B-1767683231",
      "quantity": 1,
      "unit": "EA",
      "level": 1,
      "sequence": 10,
      "created_at": "2026-01-06T07:07:11",
      "updated_at": "2026-01-06T07:11:36.555Z"
    }
  ],
  "total": 1
}
```

### documents
```json
{
  "data": [],
  "total": 0,
  "limit": 20,
  "offset": 0
}
```

### approvals
```json
{
  "data": [
    {
      "id": "74d10e47-ff4a-4415-9cec-a63cc81b393a",
      "request_type": "bom",
      "title": "ECO-REPORT-1767629039",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T16:03:59.726771",
      "product_id": "8b8aca56-4260-4606-aa69-4a5462c5455c"
    },
    {
      "id": "6ee526aa-7bd8-40df-acb4-6ac19ffcff69",
      "request_type": "bom",
      "title": "ECO-SEARCH-1767629038",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T16:03:58.867277",
      "product_id": "a0574ced-4851-4c2a-b459-2294a8ad40ce"
    },
    {
      "id": "756c0608-2fb6-4fe2-bde6-54766a8402a3",
      "request_type": "bom",
      "title": "ECO-ADV2-1767629023",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T16:03:45.342124",
      "product_id": "44f7c587-6b84-4639-8b0b-a0409a159f4e"
    },
    {
      "id": "eb361107-1dbf-405a-8eb3-53daf9fb5748",
      "request_type": "bom",
      "title": "ECO-ADV-1767629023",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T16:03:44.807597",
      "product_id": "d4b4abe9-0477-415a-9c4f-f0a2b4a958aa"
    },
    {
      "id": "660dfcbe-12d4-485c-8e60-3a9740ea48f3",
      "request_type": "bom",
      "title": "ECO-VERIFY-1767629013",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T16:03:33.810547",
      "product_id": "2c5b904f-c885-48cf-b658-1361dbd4d615"
    },
    {
      "id": "7ebb4449-ae62-4d04-98ad-fef5a42eaf18",
      "request_type": "bom",
      "title": "ECO-REPORT-1767628692",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T15:58:12.966083",
      "product_id": "734bff9e-b544-4951-8acc-7b204381c789"
    },
    {
      "id": "23613a4c-886d-47c2-a44a-badf49b8d765",
      "request_type": "bom",
      "title": "ECO-SEARCH-1767628692",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T15:58:12.064804",
      "product_id": "4830f37b-8ad1-4f02-bb76-c369bc7766f9"
    },
    {
      "id": "2f10a557-ab67-45c5-81b4-494c5494e6c2",
      "request_type": "bom",
      "title": "ECO-ADV2-1767628675",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T15:57:57.671819",
      "product_id": "adf2586f-1f15-4078-a788-f6d4a2d2a29f"
    },
    {
      "id": "cc743fe8-dee4-4bd4-a6ac-73522ac2eea5",
      "request_type": "bom",
      "title": "ECO-ADV-1767628675",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T15:57:57.140084",
      "product_id": "33d6b821-8430-4959-9f77-b9b7faac8c0c"
    },
    {
      "id": "8792ffd1-f336-42e2-b2c5-1487e6c59359",
      "request_type": "bom",
      "title": "ECO-VERIFY-1767628666",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T15:57:46.795708",
      "product_id": "c190916d-e3d3-4575-8ca3-28912aec40fe"
    },
    {
      "id": "b4f37cb3-7323-4773-b22c-fb20b7cb3f8b",
      "request_type": "bom",
      "title": "ECO-VERIFY-1767627477",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T15:37:57.838183",
      "product_id": "79366c8f-9925-4720-8de8-1efd254f6532"
    },
    {
      "id": "00cad5ec-8e41-4b90-8ac7-9986901f02c1",
      "request_type": "bom",
      "title": "ECO-REPORT-1767600898",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T08:14:58.233558",
      "product_id": "cfe09f95-121c-4423-887b-da0133c64439"
    },
    {
      "id": "1ecdb88e-9a90-40aa-81ab-5347979bb809",
      "request_type": "bom",
      "title": "ECO-SEARCH-1767600897",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T08:14:57.249201",
      "product_id": "e35831dc-321b-4fcf-94d7-0ad71d008b87"
    },
    {
      "id": "18987c33-1136-4c81-8780-b652bcc000fb",
      "request_type": "bom",
      "title": "ECO-ADV2-1767600856",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T08:14:19.082076",
      "product_id": "0e9f09fe-f0b3-4f53-a3d8-093d944ed301"
    },
    {
      "id": "25135a34-24d3-4906-879a-6cefd235b643",
      "request_type": "bom",
      "title": "ECO-ADV-1767600856",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T08:14:18.417459",
      "product_id": "666d3e38-f0d0-4fd0-94af-a6ab4d1a9d29"
    },
    {
      "id": "0e50ca42-d670-4628-85c3-94ef38a8d130",
      "request_type": "bom",
      "title": "ECO-VERIFY-1767600844",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T08:14:05.198029",
      "product_id": "309b12b1-b29f-4732-9bdb-ccf238c246a6"
    },
    {
      "id": "1616aecb-a8d5-4b1d-9c5e-bb6e95c8684e",
      "request_type": "bom",
      "title": "ECO-REPORT-1767600651",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T08:10:51.346889",
      "product_id": "0f78590f-2012-41f9-a013-7e52e3e996e5"
    },
    {
      "id": "5865e3d6-356e-4825-b804-9a319d7f9a32",
      "request_type": "bom",
      "title": "ECO-SEARCH-1767600650",
      "requester_id": "1",
      "requester_name": "1",
      "status": "pending",
      "created_at": "2026-01-05T08:10:50.302821",
      "product_id": "e96252bd-e80d-4046-af6d-b43b29d0fba4"
    },
    {
      "id": "797d1041-3c5a-44b4-930b-0248bb6bf377",
      "request_type": "bom",
      "title": "ECO-ADV2-1767600602",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T08:10:04.481066",
      "product_id": "c790839d-8c4f-4ce3-a649-6aeaef3a2c10"
    },
    {
      "id": "5365409e-1bbb-4769-95f4-430585751702",
      "request_type": "bom",
      "title": "ECO-ADV-1767600602",
      "requester_id": "1",
      "requester_name": "1",
      "status": "approved",
      "created_at": "2026-01-05T08:10:03.796264",
      "product_id": "18675b9e-5c8f-4aba-8d16-6c697546ad90"
    }
  ],
  "total": 20,
  "limit": 20,
  "offset": 0
}
```

### where_used
```json
{
  "data": {
    "item_id": "fdd72a36-be6e-4967-b697-13069e93f59f",
    "count": 1,
    "parents": [
      {
        "relationship": {
          "id": "027384a6-aea1-4b54-ae1b-0ada996ab9ca",
          "item_type_id": "Part BOM",
          "config_id": "5110fbd2-6f1b-4174-9d1f-082c38ccd472",
          "generation": 1,
          "is_current": true,
          "state": "Active",
          "current_state": null,
          "current_version_id": null,
          "created_by_id": 1,
          "created_on": "2026-01-06T07:07:11",
          "modified_by_id": null,
          "modified_on": null,
          "owner_id": null,
          "permission_id": "EffReadOnly-1767629020",
          "source_id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
          "related_id": "fdd72a36-be6e-4967-b697-13069e93f59f",
          "quantity": 1,
          "uom": "EA",
          "find_num": "10"
        },
        "parent": {
          "id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
          "item_type_id": "Part",
          "config_id": "80159431-ee95-4074-a21e-c19e9cb47e90",
          "generation": 1,
          "is_current": true,
          "state": "Draft",
          "current_state": "e0cd9dd7-cb45-4d53-a8cd-0824ed98046b",
          "current_version_id": null,
          "created_by_id": 1,
          "created_on": "2026-01-06T07:07:11",
          "modified_by_id": null,
          "modified_on": null,
          "owner_id": null,
          "permission_id": "EffReadOnly-1767629020",
          "source_id": null,
          "related_id": null,
          "item_number": "P-BOM-A-1767683231",
          "name": "Part A (Test)"
        },
        "level": 1
      }
    ]
  }
}
```

### bom_compare
```json
{
  "data": {
    "summary": {
      "added": 0,
      "removed": 1,
      "changed": 0,
      "changed_major": 0,
      "changed_minor": 0,
      "changed_info": 0
    },
    "added": [],
    "removed": [
      {
        "parent_id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
        "child_id": "fdd72a36-be6e-4967-b697-13069e93f59f",
        "relationship_id": "027384a6-aea1-4b54-ae1b-0ada996ab9ca",
        "line_key": "ROOT::bb724d96-12be-40dc-bfa5-021e2c90f2aa",
        "parent_config_id": "ROOT",
        "child_config_id": "bb724d96-12be-40dc-bfa5-021e2c90f2aa",
        "level": 1,
        "path": [
          {
            "id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
            "config_id": "ROOT",
            "item_number": "P-BOM-A-1767683231",
            "name": "Part A (Test)"
          },
          {
            "id": "fdd72a36-be6e-4967-b697-13069e93f59f",
            "config_id": "bb724d96-12be-40dc-bfa5-021e2c90f2aa",
            "item_number": "P-BOM-B-1767683231",
            "name": "Part B (Child)"
          }
        ],
        "properties": {
          "quantity": 1,
          "uom": "EA",
          "find_num": "10"
        },
        "parent": {
          "id": "d9f64c3b-4411-455c-a04f-cbaf9a7f4d7a",
          "config_id": "ROOT",
          "item_number": "P-BOM-A-1767683231",
          "name": "Part A (Test)"
        },
        "child": {
          "id": "fdd72a36-be6e-4967-b697-13069e93f59f",
          "config_id": "bb724d96-12be-40dc-bfa5-021e2c90f2aa",
          "item_number": "P-BOM-B-1767683231",
          "name": "Part B (Child)"
        }
      }
    ],
    "changed": []
  }
}
```

### substitutes
```json
{
  "data": {
    "bom_line_id": "027384a6-aea1-4b54-ae1b-0ada996ab9ca",
    "count": 0,
    "substitutes": []
  }
}
```
