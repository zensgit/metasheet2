<template>
  <div v-if="visible" class="meta-field-mgr__overlay" @click.self="requestClose">
    <div class="meta-field-mgr">
      <div class="meta-field-mgr__header">
        <h4 class="meta-field-mgr__title">{{ ml('field.title') }}</h4>
        <button class="meta-field-mgr__close" @click="requestClose">&times;</button>
      </div>

      <div class="meta-field-mgr__body">
        <div
          v-for="(field, idx) in fields"
          :key="field.id"
          class="meta-field-mgr__row"
        >
          <span class="meta-field-mgr__icon">{{ FIELD_ICONS[displayFieldType(field)] ?? '?' }}</span>

          <template v-if="editingId === field.id">
            <div class="meta-field-mgr__rename-wrap">
              <input
                class="meta-field-mgr__rename"
                :class="{ 'meta-field-mgr__rename--invalid': renameNameConflict }"
                :value="editingName"
                :aria-invalid="renameNameConflict"
                :aria-describedby="renameNameConflict ? 'meta-field-mgr-rename-error' : undefined"
                @input="editingName = ($event.target as HTMLInputElement).value"
                @keydown.enter="confirmRename(field.id)"
                @keydown.escape="cancelRename"
              />
              <span
                v-if="renameNameConflict"
                id="meta-field-mgr-rename-error"
                class="meta-field-mgr__inline-error"
                data-test="rename-conflict-error"
                role="alert"
              >{{ duplicateFieldName(editingName.trim(), isZh) }}</span>
            </div>
            <button
              class="meta-field-mgr__action meta-field-mgr__action--ok"
              :disabled="renameNameConflict"
              :title="renameNameConflict ? duplicateRenameTitle : ml('action.confirmRename')"
              @click="confirmRename(field.id)"
            >&#x2713;</button>
            <button class="meta-field-mgr__action" :title="ml('action.cancelRename')" @click="cancelRename">&#x2717;</button>
          </template>
          <template v-else>
            <span class="meta-field-mgr__name" :title="field.name">{{ field.name }}</span>
            <span class="meta-field-mgr__type">{{ fieldTypeName(field) }}</span>
            <button class="meta-field-mgr__action" :title="ml('action.configure')" @click="openConfig(field)">&#x2699;</button>
            <button class="meta-field-mgr__action" :title="ml('action.rename')" @click="startRename(field)">&#x270E;</button>
            <button class="meta-field-mgr__action" :disabled="idx === 0" :title="ml('action.moveUp')" @click="moveField(field.id, idx - 1)">&#x25B2;</button>
            <button class="meta-field-mgr__action" :disabled="idx === fields.length - 1" :title="ml('action.moveDown')" @click="moveField(field.id, idx + 1)">&#x25BC;</button>
            <button class="meta-field-mgr__action meta-field-mgr__action--danger" :title="ml('action.delete')" @click="onDeleteField(field)">&#x1F5D1;</button>
          </template>
        </div>

        <div v-if="!fields.length" class="meta-field-mgr__empty">{{ ml('field.empty') }}</div>
      </div>

      <div v-if="configTargetType" class="meta-field-mgr__config">
        <div class="meta-field-mgr__config-header">
          <strong>{{ configTarget ? configureField(configTarget.name, isZh) : configureNewField(newFieldType, isZh) }}</strong>
          <span>{{ fieldTypeLabel(configTargetType, isZh) }}</span>
        </div>
        <div v-if="fieldConfigOutdated" class="meta-field-mgr__warning">
          <span>{{ fieldConfigWarningText }}</span>
          <button class="meta-field-mgr__btn-inline" @click="reloadLatestConfig">{{ ml('action.reloadLatest') }}</button>
        </div>
        <div v-else-if="fieldConfigLiveRefreshText" class="meta-field-mgr__refresh">
          <span>{{ fieldConfigLiveRefreshText }}</span>
          <button class="meta-field-mgr__btn-inline" @click="dismissLiveRefreshNotice">{{ ml('action.dismiss') }}</button>
        </div>

        <template v-if="configTargetType === 'select' || configTargetType === 'multiSelect'">
          <div class="meta-field-mgr__field">
            <span>{{ ml('field.options') }}</span>
            <div class="meta-field-mgr__stack">
              <div v-for="(option, idx) in selectDraft.options" :key="idx" class="meta-field-mgr__option-row">
                <input v-model="option.value" class="meta-field-mgr__input" :placeholder="ml('field.optionValue')" />
                <input v-model="option.color" class="meta-field-mgr__input" placeholder="#409eff" />
                <button class="meta-field-mgr__action meta-field-mgr__action--danger" @click="removeSelectOption(idx)">&times;</button>
              </div>
              <button class="meta-field-mgr__btn-inline" @click="addSelectOption">{{ ml('action.addOption') }}</button>
            </div>
          </div>
        </template>

        <template v-else-if="configTargetType === 'link'">
          <!-- Cross-base opt-in (design 2026-06-14). OFF (default) = unchanged
               same-base path, no extra click. Disabled in edit mode because
               foreignBaseId is immutable. -->
          <label v-if="listBasesFn" class="meta-field-mgr__toggle">
            <input
              v-model="linkDraft.crossBase"
              type="checkbox"
              :disabled="linkBaseAxisLocked"
              data-test="link-cross-base-toggle"
              @change="onCrossBaseToggle"
            />
            <span>{{ ml('field.linkToAnotherBase') }}</span>
          </label>

          <template v-if="linkDraft.crossBase">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.targetBase') }}</span>
              <!-- Edit mode: base axis is locked → a single disabled option
                   showing the stored base name (raw id fallback). -->
              <select
                v-if="linkBaseAxisLocked"
                class="meta-field-mgr__select"
                disabled
                data-test="link-cross-base-select"
              >
                <option :value="linkDraft.foreignBaseId">{{ lockedForeignBaseLabel }}</option>
              </select>
              <select
                v-else
                v-model="linkDraft.foreignBaseId"
                class="meta-field-mgr__select"
                data-test="link-cross-base-select"
                @change="onCrossBaseBasePick"
              >
                <option value="">{{ ml('field.selectBase') }}</option>
                <option v-for="base in crossBaseBases" :key="base.id" :value="base.id">{{ base.name }}</option>
              </select>
            </label>
            <div v-if="linkBaseAxisLocked" class="meta-field-mgr__hint" data-test="link-cross-base-locked">
              {{ ml('field.crossBaseBaseLocked') }}
            </div>

            <!-- Foreign-sheet axis: loading / 403-gated / empty / list. The
                 403-gated state fails closed (save blocked via the guard). -->
            <div v-if="crossBaseSheetsLoading" class="meta-field-mgr__hint" data-test="link-cross-base-loading">
              {{ ml('field.crossBaseLoadingSheets') }}
            </div>
            <div v-else-if="crossBaseSheetsError" class="meta-field-mgr__hint meta-field-mgr__hint--error" data-test="link-cross-base-unreadable">
              {{ ml('field.crossBaseUnreadable') }}
            </div>
            <template v-else-if="linkDraft.foreignBaseId">
              <label v-if="crossBaseSheetOptions.length" class="meta-field-mgr__field">
                <span>{{ ml('field.targetSheet') }}</span>
                <select v-model="linkDraft.foreignSheetId" class="meta-field-mgr__select" data-test="link-cross-base-sheet-select">
                  <option value="">{{ ml('field.selectSheet') }}</option>
                  <option v-for="sheet in crossBaseSheetOptions" :key="sheet.id" :value="sheet.id">{{ sheet.name }}</option>
                </select>
              </label>
              <div v-else class="meta-field-mgr__hint" data-test="link-cross-base-empty">
                {{ ml('field.crossBaseNoSheets') }}
              </div>
            </template>
          </template>

          <label v-else class="meta-field-mgr__field">
            <span>{{ ml('field.targetSheet') }}</span>
            <select v-model="linkDraft.foreignSheetId" class="meta-field-mgr__select">
              <option value="">{{ ml('field.selectSheet') }}</option>
              <option v-for="sheet in targetSheets" :key="sheet.id" :value="sheet.id">{{ sheet.name }}</option>
            </select>
          </label>
          <label class="meta-field-mgr__toggle">
            <input
              v-model="linkDraft.limitSingleRecord"
              type="checkbox"
              :disabled="linkSingleRecordLockedByHierarchy"
              data-test="link-single-record-toggle"
            />
            <span>{{ ml('field.limitSingleLinkedRecord') }}</span>
          </label>
          <div v-if="linkSingleRecordLockedByHierarchy" class="meta-field-mgr__hint" data-test="hierarchy-parent-link-lock">
            {{ ml('field.hierarchyParentLinkLocked') }}
          </div>
        </template>

        <template v-else-if="configTargetType === 'person'">
          <div class="meta-field-mgr__hint">
            {{ ml('field.personHint') }}
          </div>
          <label class="meta-field-mgr__toggle">
            <input
              v-model="personDraft.limitSingleRecord"
              type="checkbox"
              :disabled="linkSingleRecordLockedByHierarchy"
              data-test="person-single-record-toggle"
            />
            <span>{{ ml('field.limitSinglePerson') }}</span>
          </label>
          <div v-if="linkSingleRecordLockedByHierarchy" class="meta-field-mgr__hint" data-test="hierarchy-parent-link-lock">
            {{ ml('field.hierarchyParentLinkLocked') }}
          </div>
        </template>

        <template v-else-if="configTargetType === 'lookup'">
          <label class="meta-field-mgr__field">
            <span>{{ ml('field.linkField') }}</span>
            <select v-model="lookupDraft.linkFieldId" class="meta-field-mgr__select">
              <option value="">{{ ml('field.selectLinkField') }}</option>
              <option v-for="field in linkSourceFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.foreignSheetId') }}</span>
              <input v-model="lookupDraft.foreignSheetId" class="meta-field-mgr__input" :placeholder="ml('field.optionalOverride')" />
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.targetFieldId') }}</span>
              <input v-model="lookupDraft.targetFieldId" class="meta-field-mgr__input" placeholder="fld_target" />
            </label>
          </div>
        </template>

        <template v-else-if="configTargetType === 'rollup'">
          <label class="meta-field-mgr__field">
            <span>{{ ml('field.linkField') }}</span>
            <select v-model="rollupDraft.linkFieldId" class="meta-field-mgr__select">
              <option value="">{{ ml('field.selectLinkField') }}</option>
              <option v-for="field in linkSourceFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.foreignSheetId') }}</span>
              <input v-model="rollupDraft.foreignSheetId" class="meta-field-mgr__input" :placeholder="ml('field.optionalOverride')" />
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.targetFieldId') }}</span>
              <input v-model="rollupDraft.targetFieldId" class="meta-field-mgr__input" placeholder="fld_target" />
            </label>
          </div>
          <label class="meta-field-mgr__field">
            <span>{{ ml('field.aggregation') }}</span>
            <select v-model="rollupDraft.aggregation" class="meta-field-mgr__select">
              <option value="count">{{ aggregationLabel('count', isZh) }}</option>
              <option value="sum">{{ aggregationLabel('sum', isZh) }}</option>
              <option value="avg">{{ aggregationLabel('avg', isZh) }}</option>
              <option value="min">{{ aggregationLabel('min', isZh) }}</option>
              <option value="max">{{ aggregationLabel('max', isZh) }}</option>
            </select>
          </label>
        </template>

        <template v-else-if="configTargetType === 'formula'">
          <label class="meta-field-mgr__field">
            <span>{{ ml('field.expression') }}</span>
            <textarea v-model="formulaDraft.expression" class="meta-field-mgr__textarea" placeholder="=SUM({fld_price}, {fld_tax})"></textarea>
          </label>
          <div v-if="formulaDiagnostics.length" class="meta-field-mgr__formula-diagnostics">
            <div
              v-for="diagnostic in formulaDiagnostics"
              :key="diagnostic.message"
              class="meta-field-mgr__formula-diagnostic"
              :class="`meta-field-mgr__formula-diagnostic--${diagnostic.severity}`"
            >
              {{ diagnostic.message }}
            </div>
          </div>
          <!-- M4 / Lane B2: NL→formula suggest. Describe → generate ONE candidate →
               accept (copies into the expression textarea) → Test validates. -->
          <div v-if="formulaSuggestFn" class="meta-field-mgr__field meta-field-mgr__formula-suggest" data-test="formula-suggest">
            <span>{{ ml('field.formulaSuggest.heading') }}</span>
            <textarea
              v-model="formulaSuggestInstruction"
              class="meta-field-mgr__textarea"
              :maxlength="FORMULA_SUGGEST_MAX_INSTRUCTION_LENGTH"
              :placeholder="ml('field.formulaSuggest.placeholder')"
              data-test="formula-suggest-instruction"
            ></textarea>
            <span class="meta-field-mgr__hint">{{ ml('field.formulaSuggest.hint') }}</span>
            <button
              type="button"
              class="meta-field-mgr__dryrun-btn"
              :disabled="!formulaSuggestCanRun"
              data-test="formula-suggest-generate"
              @click="runFormulaSuggest"
            >
              {{ formulaSuggestRunning ? ml('field.formulaSuggest.generating') : ml('field.formulaSuggest.generate') }}
            </button>
            <div v-if="formulaSuggestError" class="meta-field-mgr__formula-diagnostic meta-field-mgr__formula-diagnostic--error" data-test="formula-suggest-error">{{ formulaSuggestError }}</div>
            <div v-else-if="formulaSuggestCandidate" class="meta-field-mgr__dryrun-result" data-test="formula-suggest-candidate">
              <div class="meta-field-mgr__dryrun-result-head">
                <strong>{{ ml('field.formulaSuggest.candidateHeading') }}</strong>
              </div>
              <code class="meta-field-mgr__dryrun-value meta-field-mgr__formula-suggest-code" data-test="formula-suggest-candidate-code">{{ formulaSuggestCandidate }}</code>
              <div class="meta-field-mgr__formula-suggest-actions">
                <button type="button" class="meta-field-mgr__dryrun-btn" data-test="formula-suggest-accept" @click="acceptFormulaSuggest">
                  {{ ml('field.formulaSuggest.accept') }}
                </button>
                <button type="button" class="meta-field-mgr__dryrun-btn" data-test="formula-suggest-reject" @click="rejectFormulaSuggest">
                  {{ ml('field.formulaSuggest.reject') }}
                </button>
                <button type="button" class="meta-field-mgr__dryrun-btn" :disabled="!formulaSuggestCanRun" data-test="formula-suggest-regenerate" @click="runFormulaSuggest">
                  {{ ml('field.formulaSuggest.regenerate') }}
                </button>
              </div>
            </div>
            <div v-if="formulaSuggestAccepted" class="meta-field-mgr__hint" data-test="formula-suggest-accepted">{{ ml('field.formulaSuggest.acceptedHint') }}</div>
          </div>
          <!-- #5b dry-run: evaluate the UNSAVED expression against sample data (server response only) -->
          <div v-if="dryRunFn" class="meta-field-mgr__field meta-field-mgr__dryrun">
            <div v-if="dryRunReferencedFields.length" class="meta-field-mgr__dryrun-samples">
              <span>{{ ml('field.formulaDryRun.sampleHeading') }}</span>
              <label v-for="f in dryRunReferencedFields" :key="f.id" class="meta-field-mgr__dryrun-sample">
                <span class="meta-field-mgr__dryrun-sample-name">{{ f.name }}</span>
                <input v-model="dryRunSamples[f.id]" :type="f.numeric ? 'number' : 'text'" class="meta-field-mgr__input" :placeholder="f.type" />
              </label>
              <div v-if="dryRunInvalidNumeric" class="meta-field-mgr__formula-diagnostic meta-field-mgr__formula-diagnostic--error">
                {{ ml('field.formulaDryRun.invalidNumber') }}
              </div>
            </div>
            <button type="button" class="meta-field-mgr__dryrun-btn" :disabled="!dryRunCanEvaluate" @click="runDryRun">
              {{ dryRunRunning ? ml('field.formulaDryRun.evaluating') : ml('field.formulaDryRun.test') }}
            </button>
            <button
              v-if="dryRunHasRecord"
              type="button"
              class="meta-field-mgr__dryrun-btn meta-field-mgr__dryrun-btn--record"
              :disabled="!dryRunCanEvaluate"
              :title="ml('field.formulaDryRun.recordHint')"
              @click="runDryRunWithRecord"
            >
              {{ dryRunRunning ? ml('field.formulaDryRun.evaluating') : ml('field.formulaDryRun.testWithRecord') }}
            </button>
            <div v-if="dryRunTransportError" class="meta-field-mgr__dryrun-result meta-field-mgr__dryrun-result--error">{{ dryRunTransportError }}</div>
            <div v-else-if="dryRunResult" class="meta-field-mgr__dryrun-result">
              <div class="meta-field-mgr__dryrun-result-head">
                <strong>{{ dryRunResult.success ? ml('field.formulaDryRun.resultHeading') : ml('field.formulaDryRun.errorHeading') }}</strong>
                <code v-if="dryRunResult.success" class="meta-field-mgr__dryrun-value">{{ dryRunResultText }}</code>
              </div>
              <div
                v-for="(d, i) in dryRunSortedDiagnostics"
                :key="`${d.kind}-${d.code ?? ''}-${i}`"
                class="meta-field-mgr__formula-diagnostic"
                :class="`meta-field-mgr__formula-diagnostic--${d.severity}`"
              >
                <code v-if="d.code" class="meta-field-mgr__dryrun-tag">{{ d.code }}</code>{{ localizeDryRunDiag(d) }}
              </div>
            </div>
          </div>
          <div class="meta-field-mgr__field">
            <span>{{ ml('field.insertFieldToken') }}</span>
            <div class="meta-field-mgr__chips">
              <button
                v-for="field in formulaSourceFields"
                :key="field.id"
                type="button"
                class="meta-field-mgr__chip"
                :title="insertFieldTokenTitle(field.id, isZh)"
                @click="insertFormulaField(field.id)"
              >{{ field.name }}</button>
            </div>
          </div>
          <div class="meta-field-mgr__field">
            <span>{{ ml('field.formulaReference') }}</span>
            <div class="meta-field-mgr__formula-toolbar">
              <input
                v-model="formulaFunctionSearch"
                class="meta-field-mgr__input"
                :placeholder="ml('field.formulaSearchPlaceholder')"
              />
              <select v-model="formulaFunctionCategory" class="meta-field-mgr__select">
                <option value="all">{{ ml('field.allCategories') }}</option>
                <option
                  v-for="category in formulaFunctionCategories"
                  :key="category.id"
                  :value="category.id"
                >{{ category.label }}</option>
              </select>
            </div>
            <div v-if="formulaCatalogSections.length" class="meta-field-mgr__formula-docs">
              <section
                v-for="section in formulaCatalogSections"
                :key="section.category"
                class="meta-field-mgr__formula-section"
              >
                <div class="meta-field-mgr__formula-section-title">
                  <strong>{{ section.label }}</strong>
                  <span>{{ section.description }}</span>
                </div>
                <button
                  v-for="doc in section.functions"
                  :key="doc.name"
                  type="button"
                  class="meta-field-mgr__formula-doc"
                  @click="insertFormulaFunction(doc)"
                >
                  <strong>{{ doc.signature }}</strong>
                  <span>{{ doc.description }}</span>
                  <code>{{ doc.example }}</code>
                </button>
              </section>
            </div>
            <div v-else class="meta-field-mgr__formula-empty">{{ ml('field.noMatchingFunctions') }}</div>
          </div>
        </template>

        <template v-else-if="configTargetType === 'attachment'">
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.maxFiles') }}</span>
              <input v-model.number="attachmentDraft.maxFiles" class="meta-field-mgr__input" type="number" min="1" />
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.acceptedMimeTypes') }}</span>
              <input v-model="attachmentDraft.acceptedMimeTypesText" class="meta-field-mgr__input" placeholder="image/png,application/pdf" />
            </label>
          </div>
        </template>

        <template v-else-if="configTargetType === 'number'">
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.decimals') }}</span>
              <input
                class="meta-field-mgr__input"
                type="number"
                min="0"
                max="6"
                :placeholder="ml('field.preserve')"
                :value="numberDraft.decimals ?? ''"
                @input="onNumberDecimalsInput"
              />
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.unit') }}</span>
              <input v-model="numberDraft.unit" class="meta-field-mgr__input" maxlength="24" placeholder="kg, hours, pcs..." />
            </label>
          </div>
          <label class="meta-field-mgr__toggle">
            <input v-model="numberDraft.thousands" type="checkbox" />
            <span>{{ ml('field.useThousandsSeparators') }}</span>
          </label>
        </template>

        <template v-else-if="configTargetType === 'currency'">
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.currencyCode') }}</span>
              <select v-model="currencyDraft.code" class="meta-field-mgr__select">
                <option value="CNY">CNY (¥)</option>
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
                <option value="GBP">GBP (£)</option>
                <option value="JPY">JPY (¥)</option>
                <option value="HKD">HKD (HK$)</option>
                <option value="TWD">TWD (NT$)</option>
                <option value="KRW">KRW (₩)</option>
                <option value="AUD">AUD (A$)</option>
                <option value="CAD">CAD (CA$)</option>
                <option value="SGD">SGD (S$)</option>
              </select>
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.decimals') }}</span>
              <input v-model.number="currencyDraft.decimals" class="meta-field-mgr__input" type="number" min="0" max="6" />
            </label>
          </div>
        </template>

        <template v-else-if="configTargetType === 'percent'">
          <label class="meta-field-mgr__field">
            <span>{{ ml('field.decimals') }}</span>
            <input v-model.number="percentDraft.decimals" class="meta-field-mgr__input" type="number" min="0" max="6" />
          </label>
        </template>

        <template v-else-if="configTargetType === 'rating'">
          <label class="meta-field-mgr__field">
            <span>{{ ml('field.maxRating') }}</span>
            <input v-model.number="ratingDraft.max" class="meta-field-mgr__input" type="number" min="1" max="10" />
          </label>
        </template>

        <template v-else-if="configTargetType === 'autoNumber'">
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.prefix') }}</span>
              <input v-model="autoNumberDraft.prefix" class="meta-field-mgr__input" maxlength="32" placeholder="INV-" />
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.digits') }}</span>
              <input v-model.number="autoNumberDraft.digits" class="meta-field-mgr__input" type="number" min="0" max="12" />
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.startAt') }}</span>
              <input v-model.number="autoNumberDraft.start" class="meta-field-mgr__input" type="number" min="1" />
            </label>
          </div>
          <div class="meta-field-mgr__hint">
            {{ ml('field.autoNumberHint') }}
          </div>
        </template>

        <!-- A3 §2.1: AI shortcut config section (string/longText targets only) -->
        <div v-if="aiShortcutSectionVisible" class="meta-field-mgr__ai" data-test="ai-shortcut-section">
          <div class="meta-field-mgr__ai-header">
            <strong>{{ ml('field.ai.title') }}</strong>
          </div>
          <label class="meta-field-mgr__toggle">
            <input v-model="aiDraft.enabled" type="checkbox" data-test="ai-shortcut-enable" />
            <span>{{ ml('field.ai.enable') }}</span>
          </label>
          <template v-if="aiDraft.enabled">
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.ai.kind') }}</span>
              <select v-model="aiDraft.kind" class="meta-field-mgr__select" data-test="ai-shortcut-kind">
                <option v-for="kind in AI_SHORTCUT_KINDS" :key="kind" :value="kind">{{ aiShortcutKindLabel(kind, isZh) }}</option>
              </select>
            </label>
            <div class="meta-field-mgr__field">
              <span>{{ ml('field.ai.sourceFields') }}</span>
              <div class="meta-field-mgr__ai-sources">
                <label v-for="sourceField in aiSourceFieldCandidates" :key="sourceField.id" class="meta-field-mgr__ai-source">
                  <input
                    type="checkbox"
                    :checked="aiDraft.sourceFieldIds.includes(sourceField.id)"
                    :disabled="!aiDraft.sourceFieldIds.includes(sourceField.id) && aiDraft.sourceFieldIds.length >= AI_SHORTCUT_MAX_SOURCE_FIELDS"
                    :data-test="`ai-shortcut-source-${sourceField.id}`"
                    @change="toggleAiSourceField(sourceField.id, $event)"
                  />
                  <span>{{ sourceField.name }}</span>
                </label>
              </div>
              <span class="meta-field-mgr__hint">{{ ml('field.ai.sourceHint') }}</span>
              <!-- r2 item 6: distinct AI-section warning when every persisted source field was deleted.
                   It is rendered ON the source-fields control so the user sees the AI section is the
                   blocker (not their unrelated edit). The save stays blocked; no silent auto-disable. -->
              <p
                v-if="aiSourceAllDeletedBlocked"
                class="meta-field-mgr__ai-source-deleted-warning"
                data-test="ai-source-deleted-warning"
                role="alert"
              >{{ ml('field.error.aiSourceAllDeleted') }}</p>
            </div>
            <div v-if="aiDraft.kind === 'classify'" class="meta-field-mgr__field">
              <span>{{ ml('field.ai.options') }}</span>
              <div class="meta-field-mgr__stack">
                <div v-for="(option, idx) in aiDraft.options" :key="idx" class="meta-field-mgr__option-row">
                  <input
                    class="meta-field-mgr__input"
                    :maxlength="AI_SHORTCUT_MAX_OPTION_LENGTH"
                    :placeholder="ml('field.ai.optionPlaceholder')"
                    :value="option"
                    data-test="ai-shortcut-option-input"
                    @input="onAiOptionInput(idx, $event)"
                  />
                  <button class="meta-field-mgr__action meta-field-mgr__action--danger" type="button" @click="removeAiOption(idx)">&times;</button>
                </div>
                <button
                  class="meta-field-mgr__btn-inline"
                  type="button"
                  :disabled="aiDraft.options.length >= AI_SHORTCUT_MAX_OPTIONS"
                  data-test="ai-shortcut-add-option"
                  @click="addAiOption"
                >{{ ml('action.addOption') }}</button>
              </div>
            </div>
            <label v-if="aiDraft.kind === 'translate'" class="meta-field-mgr__field">
              <span>{{ ml('field.ai.targetLang') }}</span>
              <input
                v-model="aiDraft.targetLang"
                class="meta-field-mgr__input"
                :maxlength="AI_SHORTCUT_MAX_TARGET_LANG_LENGTH"
                data-test="ai-shortcut-target-lang"
              />
            </label>
            <label class="meta-field-mgr__field">
              <span>{{ ml('field.ai.instruction') }} ({{ aiDraft.instruction.length }}/{{ AI_SHORTCUT_MAX_INSTRUCTION_LENGTH }})</span>
              <textarea
                v-model="aiDraft.instruction"
                class="meta-field-mgr__textarea"
                :maxlength="AI_SHORTCUT_MAX_INSTRUCTION_LENGTH"
                data-test="ai-shortcut-instruction"
              ></textarea>
            </label>
            <!-- §2.1 LOCKED copy: REAL call consuming quota; validates the DRAFT. -->
            <div class="meta-field-mgr__ai-preview">
              <div class="meta-field-mgr__hint">
                {{ ml('field.ai.previewRealCallHint') }} {{ ml('field.ai.previewDraftHint') }}
              </div>
              <button
                type="button"
                class="meta-field-mgr__dryrun-btn"
                :disabled="!aiPreviewCanRun"
                data-test="ai-shortcut-preview-btn"
                @click="runAiPreview"
              >
                {{ aiPreviewRunning ? ml('field.ai.previewing') : ml('field.ai.previewWithRecord') }}
              </button>
              <div v-if="!currentRecordId" class="meta-field-mgr__hint">{{ ml('field.ai.previewNeedsRecord') }}</div>
              <div v-if="aiPreviewError" class="meta-field-mgr__formula-diagnostic meta-field-mgr__formula-diagnostic--error" data-test="ai-shortcut-preview-error">{{ aiPreviewError }}</div>
              <div v-else-if="aiPreviewData" class="meta-field-mgr__dryrun-result" data-test="ai-shortcut-preview-result">
                <div class="meta-field-mgr__dryrun-result-head">
                  <strong>{{ ml('field.ai.previewResult') }}</strong>
                </div>
                <div class="meta-field-mgr__ai-preview-output">{{ aiPreviewData.output }}</div>
                <div v-if="aiPreviewTokensText" class="meta-field-mgr__hint">{{ aiPreviewTokensText }}</div>
              </div>
            </div>
          </template>
          <!-- §2.4 admin usage card (automation stats-card styling family; hidden after a cached 403 probe) -->
          <div v-if="aiUsageSummary" class="meta-field-mgr__ai-usage" data-test="ai-usage-card">
            <strong>{{ ml('field.aiUsage.title') }}</strong>
            <div class="meta-field-mgr__ai-usage-stats">
              <span class="meta-field-mgr__ai-stat meta-field-mgr__ai-stat--day">{{ ml('field.aiUsage.today') }}: {{ aiUsageSummary.callerDayTokens }} / {{ aiUsageSummary.caps.tenantDailyTokenCap }}</span>
              <span class="meta-field-mgr__ai-stat meta-field-mgr__ai-stat--week">{{ ml('field.aiUsage.week') }}: {{ aiUsageSummary.callerWeekTokens }} / {{ aiUsageSummary.caps.tenantWeeklyTokenCap }}</span>
              <span class="meta-field-mgr__ai-stat meta-field-mgr__ai-stat--usd">{{ ml('field.aiUsage.instance') }}: {{ aiUsageSummary.instanceDayUsd }} / {{ aiUsageSummary.caps.accountDailyUsdCap }}</span>
            </div>
          </div>
        </div>

        <MetaFieldValidationPanel
          v-if="configTarget && validationPanelVisible"
          class="meta-field-mgr__validation"
          :field-id="configTarget.id"
          :field-type="validationPanelFieldType"
          :rules="validationDraft"
          :options="validationPanelOptions"
          @update:rules="onValidationRulesChange"
        />
        <div v-if="fieldConfigError" class="meta-field-mgr__error">{{ fieldConfigError }}</div>
        <div class="meta-field-mgr__config-actions">
          <button class="meta-field-mgr__btn-cancel" @click="closeConfig">{{ ml('action.cancel') }}</button>
          <button class="meta-field-mgr__btn-add" :disabled="Boolean(fieldConfigBlockingReason)" @click="saveConfig">{{ configTarget ? ml('field.saveSettings') : ml('field.applyDefaults') }}</button>
        </div>
      </div>

      <div class="meta-field-mgr__add-section">
        <div class="meta-field-mgr__add-row">
          <input
            v-model="newFieldName"
            class="meta-field-mgr__input"
            :class="{ 'meta-field-mgr__input--invalid': addNameConflict }"
            :placeholder="ml('field.namePlaceholder')"
            :aria-invalid="addNameConflict"
            :aria-describedby="addNameConflict ? 'meta-field-mgr-add-error' : undefined"
            @keydown.enter="onAddField"
          />
          <select v-model="newFieldType" class="meta-field-mgr__select" @change="openNewFieldConfigIfNeeded">
            <option v-for="t in FIELD_TYPES" :key="t" :value="t">{{ fieldTypeLabel(t, isZh) }}</option>
          </select>
          <button
            class="meta-field-mgr__btn-add"
            :disabled="!newFieldName.trim() || addNameConflict"
            @click="onAddField"
          >{{ ml('field.addButton') }}</button>
        </div>
        <div
          v-if="addNameConflict"
          id="meta-field-mgr-add-error"
          class="meta-field-mgr__inline-error"
          data-test="add-conflict-error"
          role="alert"
        >{{ duplicateFieldName(newFieldName.trim(), isZh) }}</div>
        <div v-if="newFieldTypeIsSystem" class="meta-field-mgr__hint meta-field-mgr__hint--system">
          {{ systemFieldHint(newFieldType) }}
        </div>
      </div>

      <div v-if="deleteTarget" class="meta-field-mgr__confirm">
        <p>{{ deleteFieldConfirm(deleteTarget.name, isZh) }}</p>
        <div class="meta-field-mgr__confirm-actions">
          <button class="meta-field-mgr__btn-cancel" @click="deleteTargetId = null">{{ ml('action.cancel') }}</button>
          <button class="meta-field-mgr__btn-delete" @click="confirmDelete">{{ ml('action.delete') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { FieldValidationRule, MetaBase, MetaField, MetaFieldCreateType, MetaSheet } from '../types'
import {
  buildFormulaFieldTokenInsertion,
  buildFormulaFunctionInsertion,
  getFormulaFunctionCategories,
  getFormulaFunctionCatalog,
  validateFormulaExpression,
  extractFormulaFieldRefs,
  type FormulaFunctionCategory,
  type FormulaFunctionDoc,
  type FormulaDiagnostic,
} from '../utils/formula-docs'
import { localizeDryRunDiagnostic } from '../utils/meta-formula-labels'
import type { DryRunResult, DryRunDiagnostic } from '../api/client'
import {
  normalizeStringArray,
  resolveAutoNumberFieldProperty,
  resolveAttachmentFieldProperty,
  resolveCurrencyFieldProperty,
  resolveFormulaFieldProperty,
  resolveLinkFieldProperty,
  resolveLookupFieldProperty,
  resolveNumberFieldProperty,
  resolvePercentFieldProperty,
  resolveRatingFieldProperty,
  resolveRollupFieldProperty,
  resolveSelectFieldOptions,
} from '../utils/field-config'
import {
  SYSTEM_FIELD_TYPES,
  isSystemFieldCreateType,
  systemFieldHint,
} from '../utils/system-fields'
import {
  aiShortcutKindLabel,
  configureField,
  configureNewField,
  deleteFieldConfirm,
  duplicateFieldName,
  aggregationLabel,
  fieldOptionRequired,
  insertFieldTokenTitle,
  managerLabel,
} from '../utils/meta-manager-labels'
import { aiTokensConsumed, fieldTypeLabel } from '../utils/meta-core-labels'
import { aiShortcutErrorMessage } from '../utils/meta-api-error-labels'
import {
  AI_SHORTCUT_COMPUTED_SOURCE_TYPES,
  AI_SHORTCUT_KINDS,
  AI_SHORTCUT_MAX_INSTRUCTION_LENGTH,
  AI_SHORTCUT_MAX_OPTIONS,
  AI_SHORTCUT_MAX_OPTION_LENGTH,
  AI_SHORTCUT_MAX_SOURCE_FIELDS,
  AI_SHORTCUT_MAX_TARGET_LANG_LENGTH,
  fetchAiUsageSummaryWithProbeCache,
  type AiFormulaSuggestOutcome,
  type AiShortcutPreviewOutcome,
} from '../composables/useAiShortcut'
import type { AiShortcutConfigInput, AiShortcutKind, AiShortcutPreviewData, AiUsageSummary } from '../api/client'
import MetaFieldValidationPanel from './MetaFieldValidationPanel.vue'

/** Field types where the validation panel is configurable. */
const VALIDATION_PANEL_TYPES: ReadonlySet<string> = new Set(['string', 'longText', 'number', 'select', 'multiSelect'])

function mapTypeForValidationPanel(fieldType: string): 'text' | 'number' | 'select' {
  if (fieldType === 'string' || fieldType === 'longText') return 'text'
  if (fieldType === 'number') return 'number'
  return 'select'
}

/**
 * Translate the engine-shape validation array stored on `field.property`
 * (`{ type, params, message }`) into the flat UI shape the panel expects
 * (`{ type, value, message }`).
 */
function rulesFromProperty(property: Record<string, unknown> | null | undefined): FieldValidationRule[] {
  const raw = property?.validation
  if (!Array.isArray(raw)) return []
  const out: FieldValidationRule[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : ''
    if (!type) continue
    const message = typeof obj.message === 'string' ? obj.message : undefined
    const params = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : undefined
    let value: FieldValidationRule['value']
    if (type === 'min' || type === 'max' || type === 'minLength' || type === 'maxLength') {
      const raw = params?.value ?? (obj as { value?: unknown }).value
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (Number.isFinite(num)) value = num
    } else if (type === 'pattern') {
      const raw = params?.regex ?? (obj as { value?: unknown }).value
      if (typeof raw === 'string') value = raw
    } else if (type === 'enum') {
      const raw = params?.values ?? (obj as { value?: unknown }).value
      if (Array.isArray(raw)) {
        value = raw.filter((v): v is string => typeof v === 'string')
      }
    }
    out.push({ type: type as FieldValidationRule['type'], ...(value !== undefined ? { value } : {}), ...(message ? { message } : {}) })
  }
  return out
}

/**
 * Translate UI-shape rules back into the engine contract for persistence
 * in `field.property.validation`. Drops entries the engine cannot
 * enforce (missing required numeric/regex/enum value).
 */
function rulesToProperty(rules: FieldValidationRule[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const rule of rules) {
    const base: Record<string, unknown> = { type: rule.type }
    if (rule.message) base.message = rule.message
    switch (rule.type) {
      case 'required':
        out.push(base)
        break
      case 'min':
      case 'max':
      case 'minLength':
      case 'maxLength': {
        const num = typeof rule.value === 'number' ? rule.value : Number(rule.value)
        if (!Number.isFinite(num)) continue
        base.params = { value: num }
        out.push(base)
        break
      }
      case 'pattern': {
        if (typeof rule.value !== 'string' || rule.value.length === 0) continue
        base.params = { regex: rule.value }
        out.push(base)
        break
      }
      case 'enum': {
        if (!Array.isArray(rule.value)) continue
        const values = rule.value.filter((v): v is string => typeof v === 'string')
        base.params = { values }
        out.push(base)
        break
      }
    }
  }
  return out
}

const FIELD_TYPES: MetaFieldCreateType[] = [
  'string', 'longText', 'number', 'boolean', 'date', 'dateTime', 'select', 'multiSelect', 'link', 'person',
  'formula', 'lookup', 'rollup', 'attachment',
  'currency', 'percent', 'rating', 'url', 'email', 'phone', 'barcode', 'qrcode', 'location',
  ...SYSTEM_FIELD_TYPES,
]
const FIELD_ICONS: Record<string, string> = {
  string: 'Aa', longText: '\u00B6', number: '#', boolean: '\u2611', date: '\u{1F4C5}', dateTime: '\u{1F552}', select: '\u25CF', multiSelect: '\u25C9',
  link: '\u21C4', person: '\u{1F464}', lookup: '\u2197', rollup: '\u03A3', formula: 'fx', attachment: '\uD83D\uDCCE',
  currency: '\u00A4', percent: '%', rating: '\u2605', url: '\u{1F517}', email: '\u2709', phone: '\u260E', barcode: '\u25A5', qrcode: '\u25A6', location: '\u{1F4CD}',
  autoNumber: '#+', createdTime: 'CT', modifiedTime: 'MT', createdBy: 'CB', modifiedBy: 'MB',
}

const props = defineProps<{
  visible: boolean
  fields: MetaField[]
  sheets: MetaSheet[]
  sheetId: string
  // S4 companion guard: hierarchy reparent writes a single `[parentRecordId]`
  // into the configured parent link field, so the field manager must not offer
  // a downgrade path from single-value link to multi-value link for those IDs.
  hierarchyParentFieldIds?: string[]
  // #5b: formula dry-run callback (the workbench wires it to client.dryRunFormula). Optional so the
  // panel degrades gracefully (button hidden) where no fn is provided.
  dryRunFn?: (params: { sheetId: string; expression: string; sampleValues: Record<string, unknown>; recordId?: string }) => Promise<DryRunResult>
  // #5c: the currently-selected record, if any. When present, a "preview with current record" button
  // appears that samples this record's real values server-side (manual samples still override).
  currentRecordId?: string | null
  // A3 §2.1: config-time AI shortcut preview over the inline DRAFT config.
  // The workbench wires this to useAiShortcut.previewWithConfig so the
  // unified in-flight guard covers this entry point too. null outcome =
  // guarded no-op (another AI request is in flight / countdown active).
  aiPreviewFn?: (params: { recordId: string; config: AiShortcutConfigInput }) => Promise<AiShortcutPreviewOutcome | null>
  // Review F3: unified AI busy state (request in flight on ANY surface, or a
  // RATE_LIMITED countdown). The preview button disables on it — same as the
  // drawer's aiBusy — instead of offering a click the guard silently refuses.
  aiPreviewBusy?: boolean
  // A3 §2.4: admin usage summary (403 probe is session-cached by the helper).
  aiUsageSummaryFn?: () => Promise<AiUsageSummary>
  // M4 / Lane B2: NL→formula suggest over the inline instruction. The
  // workbench wires this to useAiShortcut.suggestFormula so the unified
  // in-flight guard + countdown cover this entry point too. null outcome =
  // guarded no-op (another AI request is in flight / countdown active).
  formulaSuggestFn?: (params: { instruction: string }) => Promise<AiFormulaSuggestOutcome | null>
  // Cross-base link picker (design 2026-06-14). The base-read gate is the FE's
  // source of truth: these fns are the ONLY way the picker learns what bases /
  // foreign sheets exist, and both are backend base-read-gated (listBases returns
  // only bases with a readable sheet; loadContext({baseId}).sheets is read-gated).
  // The picker NEVER computes its own readability. Optional so the panel degrades
  // to same-base-only where no fn is wired. The workbench MUST resolve
  // listForeignSheetsFn from the BARE client.loadContext, never the workbench's
  // switchBase/loadBaseContext mutators (those would yank the user's active base).
  listBasesFn?: () => Promise<MetaBase[]>
  listForeignSheetsFn?: (baseId: string) => Promise<MetaSheet[]>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'create-field', input: { sheetId: string; name: string; type: string; property?: Record<string, unknown> }): void
  (e: 'update-field', fieldId: string, input: { name?: string; order?: number; type?: string; property?: Record<string, unknown> }): void
  (e: 'delete-field', fieldId: string): void
  (e: 'update:dirty', dirty: boolean): void
}>()

const { isZh } = useLocale()
const ml = (key: Parameters<typeof managerLabel>[0]) => managerLabel(key, isZh.value)
const duplicateRenameTitle = computed(() => isZh.value ? '请先解决重复名称再确认' : 'Resolve the duplicate name to confirm')

const newFieldName = ref('')
const newFieldType = ref<MetaFieldCreateType>('string')
const newFieldConfigVisible = ref(false)
const editingId = ref<string | null>(null)
const editingName = ref('')
const deleteTargetId = ref<string | null>(null)
const configTargetId = ref<string | null>(null)
const configDraftType = ref<string | null>(null)
const fieldConfigError = ref('')
// r2 item 6: distinct field-level state for "every persisted AI source field was deleted" — drives a
// warning banner ON the AI config section so the user sees the AI section is the blocker (not their
// unrelated edit). We still BLOCK the save (no silent auto-disable); this only makes it legible.
const aiSourceAllDeletedBlocked = ref(false)

const selectDraft = reactive<{ options: Array<{ value: string; color: string }> }>({
  options: [{ value: '', color: '' }],
})
// `foreignBaseId`/`crossBase` are the cross-base opt-in (design 2026-06-14).
// crossBase OFF = today's same-base path (foreignSheetId over same-base
// targetSheets); ON = foreignBaseId + foreignSheetId picked from the gated
// listBasesFn / listForeignSheetsFn. The two modes keep separate state so a
// stale id never leaks across a toggle.
const linkDraft = reactive<{ foreignSheetId: string; crossBase: boolean; foreignBaseId: string; limitSingleRecord: boolean }>({
  foreignSheetId: '',
  crossBase: false,
  foreignBaseId: '',
  limitSingleRecord: false,
})
// Cross-base picker fetched state. The base list + foreign-sheet list come ONLY
// from the gated fns — never recomputed locally. `crossBaseSheetsError` true =>
// the foreign-base read failed (403 or transport); fail-closed (the save is
// blocked and a gated notice renders), never a silent same-base save.
const crossBaseBases = ref<MetaBase[]>([])
const crossBaseSheets = ref<MetaSheet[]>([])
const crossBaseSheetsLoading = ref(false)
const crossBaseSheetsError = ref(false)
// Monotonic guard: a slow stale foreign-sheet response must not overwrite a
// newer base pick (mirrors the dryRun/aggregate seq precedent).
let crossBaseFetchSeq = 0
const personDraft = reactive<{ limitSingleRecord: boolean }>({
  limitSingleRecord: true,
})
const lookupDraft = reactive<{ linkFieldId: string; targetFieldId: string; foreignSheetId: string }>({
  linkFieldId: '',
  targetFieldId: '',
  foreignSheetId: '',
})
const rollupDraft = reactive<{ linkFieldId: string; targetFieldId: string; foreignSheetId: string; aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max' }>({
  linkFieldId: '',
  targetFieldId: '',
  foreignSheetId: '',
  aggregation: 'count',
})
const formulaDraft = reactive<{ expression: string }>({
  expression: '',
})
const formulaFunctionSearch = ref('')
const formulaFunctionCategory = ref<FormulaFunctionCategory | 'all'>('all')
const formulaFunctionCategories = computed(() => getFormulaFunctionCategories(isZh.value))
const attachmentDraft = reactive<{ maxFiles: number; acceptedMimeTypesText: string }>({
  maxFiles: 1,
  acceptedMimeTypesText: '',
})
const currencyDraft = reactive<{ code: string; decimals: number }>({
  code: 'CNY',
  decimals: 2,
})
const numberDraft = reactive<{ decimals: number | null; thousands: boolean; unit: string }>({
  decimals: null,
  thousands: false,
  unit: '',
})
const percentDraft = reactive<{ decimals: number }>({
  decimals: 1,
})
const ratingDraft = reactive<{ max: number }>({
  max: 5,
})
const autoNumberDraft = reactive<{ prefix: string; digits: number; start: number }>({
  prefix: '',
  digits: 0,
  start: 1,
})
// --- A3 §2.1: aiShortcut config draft (string/longText targets) ---
const aiDraft = reactive<{
  enabled: boolean
  kind: AiShortcutKind
  sourceFieldIds: string[]
  options: string[]
  targetLang: string
  instruction: string
}>({
  enabled: false,
  kind: 'summarize',
  sourceFieldIds: [],
  options: [],
  targetLang: '',
  instruction: '',
})
const validationDraft = ref<FieldValidationRule[]>([])
// True when the field had explicit validation rules stored OR the user
// touched the panel. Keeps us from overwriting the engine's defaults
// (e.g. default `enum` on select, default `maxLength: 10000` on string)
// when the user opened the config section but never edited rules.
const validationDraftTouched = ref(false)
const fieldConfigBaseline = ref('')
const fieldConfigOutdated = ref(false)
const fieldConfigLiveRefreshText = ref('')
const fieldConfigSourceSignature = ref('')

const configTarget = computed(() => props.fields.find((field) => field.id === configTargetId.value) ?? null)
const deleteTarget = computed(() => props.fields.find((field) => field.id === deleteTargetId.value) ?? null)
const linkSourceFields = computed(() => props.fields.filter((field) => field.type === 'link'))
const targetSheets = computed(() => props.sheets.filter((sheet) => sheet.id !== props.sheetId))
const hierarchyParentFieldIdSet = computed(() => new Set(props.hierarchyParentFieldIds ?? []))
const linkSingleRecordLockedByHierarchy = computed(() => {
  const target = configTarget.value
  return target?.type === 'link'
    && target.property?.limitSingleRecord === true
    && hierarchyParentFieldIdSet.value.has(target.id)
})
// --- Cross-base link picker (design 2026-06-14) ---
// True when editing an EXISTING field that already stores a foreignBaseId:
// foreignBaseId is immutable, so the cross-base toggle AND the base <select>
// are read-only (only the foreign sheet within the locked base may change).
const linkBaseAxisLocked = computed(() =>
  Boolean(configTarget.value) && resolveLinkFieldProperty(configTarget.value?.property).foreignBaseId !== null,
)
// The active base id, inferred from the current sheet (props carries no baseId).
// Used only to exclude the current sheet from the foreign-sheet list when the
// picked foreign base IS the active base (you can't link a sheet to itself).
const activeBaseId = computed(() =>
  props.sheets.find((sheet) => sheet.id === props.sheetId)?.baseId ?? null,
)
const crossBaseSheetOptions = computed(() => {
  const sameAsActive = !!linkDraft.foreignBaseId && linkDraft.foreignBaseId === activeBaseId.value
  return sameAsActive
    ? crossBaseSheets.value.filter((sheet) => sheet.id !== props.sheetId)
    : crossBaseSheets.value
})
// Resolve the stored foreign-base display name in edit mode (single locked
// option). Falls back to the raw id if listBasesFn hasn't resolved it — the
// locked select never depends on the full base list loading.
const lockedForeignBaseLabel = computed(() => {
  const id = linkDraft.foreignBaseId
  if (!id) return ''
  return crossBaseBases.value.find((base) => base.id === id)?.name ?? id
})

async function loadCrossBaseBases() {
  const fn = props.listBasesFn
  if (!fn) return
  try {
    crossBaseBases.value = await fn()
  } catch {
    // Read failure on the base list is non-fatal: the user simply has no bases
    // to pick (the gated save still blocks). Never throw out of config load.
    crossBaseBases.value = []
  }
}

// Fetch the foreign base's readable sheets via the gated fn. Fail-closed: any
// rejection (403 / transport) sets crossBaseSheetsError so the UI renders the
// gated notice and the save is blocked — it must NEVER fall through to a
// same-base property.
async function fetchCrossBaseSheets(baseId: string) {
  const fn = props.listForeignSheetsFn
  const seq = ++crossBaseFetchSeq
  crossBaseSheetsError.value = false
  if (!fn || !baseId) {
    crossBaseSheets.value = []
    crossBaseSheetsLoading.value = false
    return
  }
  crossBaseSheetsLoading.value = true
  try {
    const sheets = await fn(baseId)
    if (seq !== crossBaseFetchSeq) return
    crossBaseSheets.value = sheets
  } catch {
    if (seq !== crossBaseFetchSeq) return
    crossBaseSheets.value = []
    crossBaseSheetsError.value = true
  } finally {
    if (seq === crossBaseFetchSeq) crossBaseSheetsLoading.value = false
  }
}

function resetCrossBaseState() {
  crossBaseFetchSeq++
  crossBaseBases.value = []
  crossBaseSheets.value = []
  crossBaseSheetsLoading.value = false
  crossBaseSheetsError.value = false
}

// Toggle handler — clears the OTHER mode's selection so a stale sheet id can
// never leak into an emit. Off->on loads the base list; on->off restores the
// same-base path. Disabled in edit mode (immutability), so this only fires for
// new fields.
function onCrossBaseToggle() {
  if (linkBaseAxisLocked.value) return
  linkDraft.foreignSheetId = ''
  linkDraft.foreignBaseId = ''
  resetCrossBaseState()
  if (linkDraft.crossBase) void loadCrossBaseBases()
}

// Base pick — clears the prior foreign sheet (it belonged to the old base) and
// fetches the new base's sheets. Disabled in edit mode.
function onCrossBaseBasePick() {
  if (linkBaseAxisLocked.value) return
  linkDraft.foreignSheetId = ''
  void fetchCrossBaseSheets(linkDraft.foreignBaseId)
}

const formulaSourceFields = computed(() =>
  props.fields.filter((field) => field.id !== configTarget.value?.id && field.type !== 'formula'),
)
const formulaCatalogSections = computed(() =>
  getFormulaFunctionCatalog(formulaFunctionSearch.value, formulaFunctionCategory.value, isZh.value)
    .map((section) => ({ ...section, functions: section.functions.slice(0, 6) })),
)
const formulaDiagnostics = computed<FormulaDiagnostic[]>(() =>
  configTargetType.value === 'formula'
    ? validateFormulaExpression(formulaDraft.expression, formulaSourceFields.value, isZh.value)
    : [],
)
const configTargetType = computed(() => {
  if (configTarget.value) return configDraftType.value
  return newFieldConfigVisible.value && requiresConfig(newFieldType.value) ? newFieldType.value : null
})

// ---- #5b formula dry-run (C1–C4 per design #1869) ----
const DRY_RUN_NUMERIC_TYPES = new Set(['number', 'currency', 'percent', 'rating', 'autoNumber'])
const dryRunSamples = reactive<Record<string, string>>({})
const dryRunResult = ref<DryRunResult | null>(null)
const dryRunRunning = ref(false)
const dryRunTransportError = ref<string | null>(null)
let dryRunSeq = 0
// C1: dry-run state is EPHEMERAL — cleared whenever the field config resets (close/reopen), so a
// reopened formula field never pre-fills last time's sample values (and missing_sample still fires).
function resetDryRunState() {
  for (const key of Object.keys(dryRunSamples)) delete dryRunSamples[key]
  dryRunResult.value = null
  dryRunTransportError.value = null
  dryRunRunning.value = false
  dryRunSeq++
}
// C1: referenced fields come from the EXISTING extractFormulaFieldRefs (no mirror helper → no drift)
const dryRunReferencedFields = computed(() => {
  if (configTargetType.value !== 'formula') return []
  // INTERSECT with formulaSourceFields — unknown {fld} refs are owned by the static diagnostics
  // (which error and disable Evaluate), so they don't get confusing sample rows here.
  return extractFormulaFieldRefs(formulaDraft.expression)
    .map((id) => formulaSourceFields.value.find((f) => f.id === id))
    .filter((field): field is NonNullable<typeof field> => Boolean(field))
    .map((field) => ({ id: field.id, name: field.name, type: field.type, numeric: DRY_RUN_NUMERIC_TYPES.has(field.type) }))
})
const dryRunInvalidNumeric = computed(() =>
  dryRunReferencedFields.value.some((f) => {
    const raw = dryRunSamples[f.id]
    const s = raw == null ? '' : String(raw) // type="number" v-model can yield a number, not a string
    return f.numeric && s.trim() !== '' && Number.isNaN(Number(s))
  }),
)
const dryRunHasStaticError = computed(() => formulaDiagnostics.value.some((d) => d.severity === 'error'))
// C2: Evaluate enabled iff non-empty + no static error + no invalid numeric input + not running + fn wired
const dryRunCanEvaluate = computed(() =>
  Boolean(props.dryRunFn) &&
  formulaDraft.expression.trim().length > 0 &&
  !dryRunHasStaticError.value &&
  !dryRunInvalidNumeric.value &&
  !dryRunRunning.value,
)
// C3: diagnostics sorted error > warning > info
const dryRunSortedDiagnostics = computed<DryRunDiagnostic[]>(() => {
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 }
  return [...(dryRunResult.value?.diagnostics ?? [])].sort((a, b) => order[a.severity] - order[b.severity])
})
const dryRunResultText = computed(() => {
  const r = dryRunResult.value
  if (!r || !r.success || r.result === null || r.result === undefined) return ''
  return String(r.result)
})
function localizeDryRunDiag(diagnostic: DryRunDiagnostic): string {
  return localizeDryRunDiagnostic(diagnostic, isZh.value) // NEVER renders diagnostic.message
}
// C1 serialization: omit empty (→ server missing_sample), Number() for numeric, boolean for checkbox, else string
function buildDryRunSampleValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of dryRunReferencedFields.value) {
    const raw = dryRunSamples[f.id]
    const s = raw == null ? '' : String(raw)
    if (s.trim() === '') continue // omit empty → server missing_sample
    if (f.numeric) out[f.id] = Number(s)
    else if (f.type === 'boolean') out[f.id] = s === 'true'
    else out[f.id] = s
  }
  return out
}
// #5c: a record is available to sample from → show the "preview with current record" button.
const dryRunHasRecord = computed(() => Boolean(props.currentRecordId))
// Shared core. recordId omitted → manual-sample path (#5b); recordId present → server samples that
// record's RAW values (#5c) with manual samples as per-field overrides. Same seq/stale/error handling.
async function executeDryRun(recordId?: string) {
  if (!props.dryRunFn || !dryRunCanEvaluate.value) return
  const seq = ++dryRunSeq
  dryRunRunning.value = true
  dryRunTransportError.value = null
  try {
    const res = await props.dryRunFn({
      sheetId: props.sheetId,
      expression: formulaDraft.expression,
      sampleValues: buildDryRunSampleValues(),
      ...(recordId ? { recordId } : {}),
    })
    if (seq !== dryRunSeq) return // stale response superseded
    dryRunResult.value = res
  } catch (err) {
    if (seq !== dryRunSeq) return
    dryRunResult.value = null
    const status = (err as { status?: number }).status
    if (status === 403) dryRunTransportError.value = ml('field.formulaDryRun.forbidden')
    else if (status === 413 || status === 422) dryRunTransportError.value = ml('field.formulaDryRun.tooLarge')
    else dryRunTransportError.value = ml('field.formulaDryRun.requestFailed')
  } finally {
    if (seq === dryRunSeq) dryRunRunning.value = false
  }
}
function runDryRun() { void executeDryRun() }
function runDryRunWithRecord() { void executeDryRun(props.currentRecordId ?? undefined) }
// C2: result describes the current expression; any edit clears it + invalidates an in-flight response.
// Also clear `running` — otherwise a superseded request's `finally` skips the reset (seq !== dryRunSeq)
// and the Evaluate button would stay disabled for the new expression.
watch(() => formulaDraft.expression, () => {
  dryRunResult.value = null
  dryRunTransportError.value = null
  dryRunRunning.value = false
  dryRunSeq++
})

// ---- M4 / Lane B2: NL→formula suggest (describe → candidate → accept) ----
const FORMULA_SUGGEST_MAX_INSTRUCTION_LENGTH = 500
const formulaSuggestInstruction = ref('')
const formulaSuggestCandidate = ref('')
const formulaSuggestError = ref('')
const formulaSuggestRunning = ref(false)
// The expression value we last copied via Accept. The "accepted, run Test" hint
// shows only while the textarea still holds exactly that — a manual edit (or a
// reset) makes it stale automatically (no watcher-ordering hazard).
const formulaSuggestAcceptedExpression = ref<string | null>(null)
const formulaSuggestAccepted = computed(
  () => formulaSuggestAcceptedExpression.value !== null && formulaDraft.expression === formulaSuggestAcceptedExpression.value,
)
let formulaSuggestSeq = 0

const formulaSuggestCanRun = computed(() =>
  Boolean(props.formulaSuggestFn) &&
  formulaSuggestInstruction.value.trim().length > 0 &&
  !formulaSuggestRunning.value &&
  // Review F3: countdown / cross-surface in-flight → disable, like the AI preview.
  !props.aiPreviewBusy,
)

async function runFormulaSuggest() {
  if (!props.formulaSuggestFn || !formulaSuggestCanRun.value) return
  const seq = ++formulaSuggestSeq
  formulaSuggestRunning.value = true
  formulaSuggestError.value = ''
  formulaSuggestCandidate.value = ''
  formulaSuggestAcceptedExpression.value = null
  try {
    const outcome = await props.formulaSuggestFn({ instruction: formulaSuggestInstruction.value.trim() })
    if (seq !== formulaSuggestSeq) return
    if (!outcome) return // unified in-flight guard refused (another AI request active)
    if ('error' in outcome) {
      // AI-state errors use the §2.3 copy (fall back to the raw message for unknown codes).
      formulaSuggestError.value = aiShortcutErrorMessage(outcome.error.code, isZh.value) ?? outcome.error.message
      return
    }
    formulaSuggestCandidate.value = outcome.data.candidate
  } finally {
    if (seq === formulaSuggestSeq) formulaSuggestRunning.value = false
  }
}

// Accept = copy the candidate into the expression textarea (no auto-persist —
// the user still runs Test/dry-run + Save). The expression watch clears the
// candidate, so re-show the "accepted" hint explicitly.
function acceptFormulaSuggest() {
  if (!formulaSuggestCandidate.value) return
  const accepted = formulaSuggestCandidate.value
  formulaDraft.expression = accepted
  formulaSuggestCandidate.value = ''
  formulaSuggestError.value = ''
  formulaSuggestAcceptedExpression.value = accepted
}

function rejectFormulaSuggest() {
  formulaSuggestCandidate.value = ''
  formulaSuggestError.value = ''
  formulaSuggestAcceptedExpression.value = null
}

function resetFormulaSuggestState() {
  formulaSuggestInstruction.value = ''
  formulaSuggestCandidate.value = ''
  formulaSuggestError.value = ''
  formulaSuggestRunning.value = false
  formulaSuggestAcceptedExpression.value = null
  formulaSuggestSeq++
}

const fieldConfigSchemaChanged = computed(() =>
  Boolean(configTarget.value && configDraftType.value && displayFieldType(configTarget.value) !== configDraftType.value),
)
const fieldConfigBlockingReason = computed(() => {
  if (!configTarget.value || !fieldConfigOutdated.value || !fieldConfigSchemaChanged.value) return ''
  return ml('field.changedTypeBlocking')
})
const fieldConfigWarningText = computed(() => {
  return fieldConfigBlockingReason.value || ml('field.changedWarning')
})
const newFieldTypeIsSystem = computed(() => isSystemFieldCreateType(newFieldType.value))

/**
 * Compare field names case-insensitively after trimming. Field-name UIs
 * across the app treat names as user-facing labels, and the friendlier
 * default for inline conflict detection is to flag "Status" vs "status"
 * before the user round-trips to the backend.
 */
function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase()
}

const addNameConflict = computed(() => {
  const normalized = normalizeFieldName(newFieldName.value)
  if (!normalized) return false
  return props.fields.some((field) => normalizeFieldName(field.name) === normalized)
})

const renameNameConflict = computed(() => {
  if (!editingId.value) return false
  const normalized = normalizeFieldName(editingName.value)
  if (!normalized) return false
  return props.fields.some(
    (field) => field.id !== editingId.value && normalizeFieldName(field.name) === normalized,
  )
})

const validationPanelVisible = computed(() => {
  const draftType = configDraftType.value
  if (!draftType) return false
  return VALIDATION_PANEL_TYPES.has(draftType)
})

const validationPanelFieldType = computed(() => {
  return mapTypeForValidationPanel(configDraftType.value ?? '')
})

const validationPanelOptions = computed(() => {
  if (configDraftType.value !== 'select' && configDraftType.value !== 'multiSelect') return undefined
  return selectDraft.options
    .map((option) => ({ value: option.value.trim() }))
    .filter((option) => option.value.length > 0)
})

function onValidationRulesChange(rules: FieldValidationRule[]) {
  validationDraft.value = [...rules]
  validationDraftTouched.value = true
}

function onNumberDecimalsInput(event: Event) {
  const value = (event.target as HTMLInputElement).value.trim()
  numberDraft.decimals = value === '' ? null : Number(value)
}

function requiresConfig(type: MetaFieldCreateType): boolean {
  return [
    'select', 'multiSelect', 'link', 'person', 'lookup', 'rollup', 'formula', 'attachment',
    'number', 'currency', 'percent', 'rating', 'longText', 'autoNumber',
  ].includes(type)
}

function displayFieldType(field: MetaField): string {
  if (field.type === 'link' && field.property?.refKind === 'user') return 'person'
  return field.type
}

function fieldTypeName(field: MetaField): string {
  return fieldTypeLabel(displayFieldType(field), isZh.value)
}

function resetAiDraft() {
  aiDraft.enabled = false
  aiDraft.kind = 'summarize'
  aiDraft.sourceFieldIds = []
  aiDraft.options = []
  aiDraft.targetLang = ''
  aiDraft.instruction = ''
  aiPreviewSeq++
  aiPreviewRunning.value = false
  aiPreviewData.value = null
  aiPreviewError.value = ''
}

function resetDrafts() {
  resetAiDraft()
  selectDraft.options = [{ value: '', color: '' }]
  linkDraft.foreignSheetId = ''
  linkDraft.crossBase = false
  linkDraft.foreignBaseId = ''
  linkDraft.limitSingleRecord = false
  resetCrossBaseState()
  personDraft.limitSingleRecord = true
  lookupDraft.linkFieldId = ''
  lookupDraft.targetFieldId = ''
  lookupDraft.foreignSheetId = ''
  rollupDraft.linkFieldId = ''
  rollupDraft.targetFieldId = ''
  rollupDraft.foreignSheetId = ''
  rollupDraft.aggregation = 'count'
  formulaDraft.expression = ''
  formulaFunctionSearch.value = ''
  formulaFunctionCategory.value = 'all'
  resetDryRunState()
  resetFormulaSuggestState()
  attachmentDraft.maxFiles = 1
  attachmentDraft.acceptedMimeTypesText = ''
  currencyDraft.code = 'CNY'
  currencyDraft.decimals = 2
  numberDraft.decimals = null
  numberDraft.thousands = false
  numberDraft.unit = ''
  percentDraft.decimals = 1
  ratingDraft.max = 5
  autoNumberDraft.prefix = ''
  autoNumberDraft.digits = 0
  autoNumberDraft.start = 1
  validationDraft.value = []
  validationDraftTouched.value = false
  fieldConfigError.value = ''
  aiSourceAllDeletedBlocked.value = false
}

function serializeFieldDraft(type: string | null): string {
  const validation = VALIDATION_PANEL_TYPES.has(type ?? '') && validationDraftTouched.value
    ? rulesToProperty(validationDraft.value)
    : undefined
  if (type === 'select' || type === 'multiSelect') {
    return JSON.stringify({
      options: selectDraft.options.map((option) => ({
        value: option.value.trim(),
        color: option.color.trim(),
      })),
      validation,
    })
  }
  if (type === 'link') {
    return JSON.stringify({
      foreignSheetId: linkDraft.foreignSheetId,
      // Cross-base keys only when toggled on, so a same-base field's signature
      // is byte-for-byte what it was before this feature (no spurious dirty).
      ...(linkDraft.crossBase ? { crossBase: true, foreignBaseId: linkDraft.foreignBaseId } : {}),
      limitSingleRecord: linkSingleRecordLockedByHierarchy.value || linkDraft.limitSingleRecord,
    })
  }
  if (type === 'person') {
    return JSON.stringify({
      limitSingleRecord: linkSingleRecordLockedByHierarchy.value || personDraft.limitSingleRecord,
    })
  }
  if (type === 'lookup') {
    return JSON.stringify({
      linkFieldId: lookupDraft.linkFieldId,
      targetFieldId: lookupDraft.targetFieldId,
      foreignSheetId: lookupDraft.foreignSheetId,
    })
  }
  if (type === 'rollup') {
    return JSON.stringify({
      linkFieldId: rollupDraft.linkFieldId,
      targetFieldId: rollupDraft.targetFieldId,
      foreignSheetId: rollupDraft.foreignSheetId,
      aggregation: rollupDraft.aggregation,
    })
  }
  if (type === 'formula') {
    return JSON.stringify({ expression: formulaDraft.expression.trim() })
  }
  if (type === 'attachment') {
    return JSON.stringify({
      maxFiles: attachmentDraft.maxFiles,
      acceptedMimeTypesText: attachmentDraft.acceptedMimeTypesText.trim(),
    })
  }
  if (type === 'currency') {
    return JSON.stringify({ code: currencyDraft.code.trim().toUpperCase(), decimals: currencyDraft.decimals })
  }
  if (type === 'number') {
    return JSON.stringify({
      decimals: numberDraft.decimals,
      thousands: numberDraft.thousands,
      unit: numberDraft.unit.trim(),
      validation,
    })
  }
  if (type === 'percent') {
    return JSON.stringify({ decimals: percentDraft.decimals })
  }
  if (type === 'rating') {
    return JSON.stringify({ max: ratingDraft.max })
  }
  if (type === 'autoNumber') {
    return JSON.stringify({
      prefix: autoNumberDraft.prefix.trim(),
      digits: autoNumberDraft.digits,
      start: autoNumberDraft.start,
      startAt: autoNumberDraft.start,
    })
  }
  if (type === 'string' || type === 'longText') {
    // A3: the ai draft participates in dirty/outdated detection so an
    // aiShortcut-only edit marks the config dirty (and a background field
    // change while editing flips the outdated banner, same as validation).
    return JSON.stringify({ validation, aiShortcut: serializeAiDraft() })
  }
  if (type === 'number') {
    return JSON.stringify({ validation })
  }
  return ''
}

function serializeAiDraft(): Record<string, unknown> | null {
  if (!aiDraft.enabled) return null
  return {
    kind: aiDraft.kind,
    sourceFieldIds: [...aiDraft.sourceFieldIds],
    options: [...aiDraft.options],
    targetLang: aiDraft.targetLang,
    instruction: aiDraft.instruction,
  }
}

function serializeFieldSourceSignature(field: MetaField | null): string {
  if (!field) return ''
  return JSON.stringify({
    id: field.id,
    name: field.name,
    type: field.type,
    property: field.property ?? null,
    fields: props.fields.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      property: item.property ?? null,
    })),
    sheets: props.sheets.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
    })),
    sheetId: props.sheetId,
  })
}

function hydrateExistingFieldConfig(field: MetaField, options?: { liveRefreshText?: string }) {
  newFieldConfigVisible.value = false
  configTargetId.value = field.id
  resetDrafts()
  const fieldType = displayFieldType(field)
  configDraftType.value = fieldType
  fieldConfigLiveRefreshText.value = options?.liveRefreshText ?? ''
  if (fieldType === 'select' || fieldType === 'multiSelect') {
    const optionsList = resolveSelectFieldOptions(field.property)
    selectDraft.options = optionsList.length > 0
      ? optionsList.map((option) => ({ value: option.value, color: option.color ?? '' }))
      : [{ value: '', color: '' }]
  } else if (fieldType === 'link') {
    const property = resolveLinkFieldProperty(field.property)
    linkDraft.foreignSheetId = property.foreignSheetId ?? ''
    linkDraft.limitSingleRecord = property.limitSingleRecord
    // Cross-base existing field: reflect the stored base (axis locked), resolve
    // its name for the locked select, and fetch its sheets so the foreign sheet
    // shows selected. A foreign-base 403 surfaces as the gated state (not blank).
    if (property.foreignBaseId) {
      linkDraft.crossBase = true
      linkDraft.foreignBaseId = property.foreignBaseId
      void loadCrossBaseBases()
      void fetchCrossBaseSheets(property.foreignBaseId)
    }
  } else if (fieldType === 'person') {
    const property = resolveLinkFieldProperty(field.property)
    personDraft.limitSingleRecord = property.limitSingleRecord || property.limitSingleRecord !== false
  } else if (fieldType === 'lookup') {
    const property = resolveLookupFieldProperty(field.property)
    lookupDraft.linkFieldId = property.linkFieldId ?? ''
    lookupDraft.targetFieldId = property.targetFieldId ?? ''
    lookupDraft.foreignSheetId = property.foreignSheetId ?? ''
  } else if (fieldType === 'rollup') {
    const property = resolveRollupFieldProperty(field.property)
    rollupDraft.linkFieldId = property.linkFieldId ?? ''
    rollupDraft.targetFieldId = property.targetFieldId ?? ''
    rollupDraft.foreignSheetId = property.foreignSheetId ?? ''
    rollupDraft.aggregation = property.aggregation
  } else if (fieldType === 'formula') {
    formulaDraft.expression = resolveFormulaFieldProperty(field.property).expression
  } else if (fieldType === 'attachment') {
    const property = resolveAttachmentFieldProperty(field.property)
    attachmentDraft.maxFiles = property.maxFiles ?? 1
    attachmentDraft.acceptedMimeTypesText = property.acceptedMimeTypes.join(',')
  } else if (fieldType === 'currency') {
    const property = resolveCurrencyFieldProperty(field.property)
    currencyDraft.code = property.code
    currencyDraft.decimals = property.decimals
  } else if (fieldType === 'number') {
    const property = resolveNumberFieldProperty(field.property)
    numberDraft.decimals = property.decimals
    numberDraft.thousands = property.thousands
    numberDraft.unit = property.unit
  } else if (fieldType === 'percent') {
    const property = resolvePercentFieldProperty(field.property)
    percentDraft.decimals = property.decimals
  } else if (fieldType === 'rating') {
    const property = resolveRatingFieldProperty(field.property)
    ratingDraft.max = property.max
  } else if (fieldType === 'autoNumber') {
    const property = resolveAutoNumberFieldProperty(field.property)
    autoNumberDraft.prefix = property.prefix
    autoNumberDraft.digits = property.digits
    autoNumberDraft.start = property.start
  } else if (fieldType === 'string' || fieldType === 'longText') {
    // A3 CLOBBER GUARD leg 1 (LOCKED §2.1): hydrate the persisted aiShortcut
    // into the draft so EVERY subsequent save re-emits it (see
    // currentDraftProperty). Without this, any validation-only save would
    // silently delete the configured shortcut (property is replaced wholesale).
    hydrateAiShortcutDraft(field.property)
  }
  if (VALIDATION_PANEL_TYPES.has(fieldType)) {
    const loaded = rulesFromProperty(field.property ?? null)
    validationDraft.value = loaded
    validationDraftTouched.value = loaded.length > 0
  }
  fieldConfigBaseline.value = serializeFieldDraft(fieldType)
  fieldConfigOutdated.value = false
  fieldConfigSourceSignature.value = serializeFieldSourceSignature(field)
}

function closeConfig() {
  if (!configTarget.value) {
    newFieldConfigVisible.value = false
  }
  configTargetId.value = null
  configDraftType.value = null
  fieldConfigBaseline.value = ''
  fieldConfigOutdated.value = false
  fieldConfigLiveRefreshText.value = ''
  fieldConfigSourceSignature.value = ''
  resetDrafts()
}

function resetTransientState() {
  newFieldName.value = ''
  newFieldType.value = 'string'
  editingId.value = null
  editingName.value = ''
  deleteTargetId.value = null
  configTargetId.value = null
  configDraftType.value = null
  newFieldConfigVisible.value = false
  fieldConfigBaseline.value = ''
  fieldConfigOutdated.value = false
  fieldConfigLiveRefreshText.value = ''
  fieldConfigSourceSignature.value = ''
  resetDrafts()
}

function requestClose() {
  if (!confirmDiscardFieldManagerChanges()) return
  resetTransientState()
  emit('close')
}

function openNewFieldConfigIfNeeded() {
  if (!requiresConfig(newFieldType.value)) {
    newFieldConfigVisible.value = false
    configTargetId.value = null
    configDraftType.value = null
    fieldConfigBaseline.value = ''
    fieldConfigOutdated.value = false
    fieldConfigLiveRefreshText.value = ''
    fieldConfigSourceSignature.value = ''
    return
  }
  resetDrafts()
  newFieldConfigVisible.value = true
  configTargetId.value = null
  configDraftType.value = newFieldType.value
  fieldConfigBaseline.value = serializeFieldDraft(newFieldType.value)
  fieldConfigOutdated.value = false
  fieldConfigLiveRefreshText.value = ''
  fieldConfigSourceSignature.value = ''
}

// --- A3: aiShortcut config section logic (string/longText targets) ---

const aiShortcutSectionVisible = computed(() =>
  configTargetType.value === 'string' || configTargetType.value === 'longText',
)

// Constraint mirror (A2): existing, non-computed, not the target field itself.
const aiSourceFieldCandidates = computed(() =>
  props.fields.filter((field) =>
    field.id !== configTarget.value?.id && !AI_SHORTCUT_COMPUTED_SOURCE_TYPES.has(field.type),
  ),
)

function hydrateAiShortcutDraft(property: Record<string, unknown> | null | undefined) {
  const raw = property?.aiShortcut
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    aiDraft.enabled = false
    return
  }
  const obj = raw as Record<string, unknown>
  const params = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
    ? (obj.params as Record<string, unknown>)
    : {}
  aiDraft.enabled = true
  aiDraft.kind = (AI_SHORTCUT_KINDS as readonly string[]).includes(String(obj.kind))
    ? (obj.kind as AiShortcutKind)
    : 'summarize'
  aiDraft.sourceFieldIds = Array.isArray(obj.sourceFieldIds)
    ? obj.sourceFieldIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  aiDraft.options = Array.isArray(params.options)
    ? params.options.filter((entry): entry is string => typeof entry === 'string')
    : []
  aiDraft.targetLang = typeof params.targetLang === 'string' ? params.targetLang : ''
  aiDraft.instruction = typeof params.instruction === 'string' ? params.instruction : ''
}

function toggleAiSourceField(fieldId: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  if (checked) {
    if (aiDraft.sourceFieldIds.includes(fieldId)) return
    aiDraft.sourceFieldIds = [...aiDraft.sourceFieldIds, fieldId]
  } else {
    aiDraft.sourceFieldIds = aiDraft.sourceFieldIds.filter((id) => id !== fieldId)
  }
}

function addAiOption() {
  if (aiDraft.options.length >= AI_SHORTCUT_MAX_OPTIONS) return
  aiDraft.options = [...aiDraft.options, '']
}

function removeAiOption(index: number) {
  aiDraft.options = aiDraft.options.filter((_, i) => i !== index)
}

function onAiOptionInput(index: number, event: Event) {
  const next = [...aiDraft.options]
  next[index] = (event.target as HTMLInputElement).value
  aiDraft.options = next
}

/**
 * Resolve the draft into the canonical wire config, mirroring the A2 caps
 * client-side. ok:false → fieldConfigError is already set. ok:true with no
 * config = the toggle is off (removal-by-key-omission, §2.1 LOCK — never
 * `aiShortcut: null`, which the backend 400s).
 *
 * r2 item 5 — INTENTIONAL DRAFT CANONICALIZATION (review F1). Because the
 * §2.1 clobber guard re-emits this resolved config on EVERY save of a
 * string/longText field (even a validation-only edit), the returned config is a
 * canonical form of the persisted aiShortcut, not a verbatim copy. The
 * transforms applied here, all of them deliberate:
 *   - self-heal deleted sources: `sourceFieldIds` is filtered to ids that still
 *     exist as candidates, so a since-deleted source field is dropped rather
 *     than re-persisted as a dangling reference (see item 6 for the all-deleted
 *     case, which BLOCKS instead of silently emptying);
 *   - drop inert non-classify options: `params.options` is emitted only when
 *     `kind === 'classify'` (options on summarize/translate/custom are inert,
 *     so they are not round-tripped);
 *   - drop inert non-translate targetLang likewise (emitted only for
 *     `kind === 'translate'`);
 *   - trim + drop empties: options are trimmed and blank ones removed;
 *     `targetLang` and `instruction` are trimmed (an empty instruction is
 *     omitted entirely).
 * Net effect: a validation-only save may rewrite the stored aiShortcut into this
 * canonical shape. That is acceptable and by design (it cannot enable/disable the
 * shortcut or change its kind/instruction intent) — flagged here so the rewrite
 * is not mistaken for an accidental clobber.
 */
function resolveAiShortcutDraft(): { ok: boolean; config?: AiShortcutConfigInput } {
  aiSourceAllDeletedBlocked.value = false
  if (!aiDraft.enabled) return { ok: true }
  const candidateIds = new Set(aiSourceFieldCandidates.value.map((field) => field.id))
  const sourceFieldIds = aiDraft.sourceFieldIds.filter((id) => candidateIds.has(id))
  if (sourceFieldIds.length === 0) {
    // r2 item 6: separate "every configured source was DELETED" (the draft had source ids, but none
    // survive as candidates) from "none picked yet". The former gets an actionable, AI-section-specific
    // message + a distinct warning state; we still BLOCK (no silent auto-disable of the shortcut).
    if (aiDraft.sourceFieldIds.length > 0) {
      aiSourceAllDeletedBlocked.value = true
      fieldConfigError.value = ml('field.error.aiSourceAllDeleted')
      return { ok: false }
    }
    fieldConfigError.value = ml('field.error.aiSourceRequired')
    return { ok: false }
  }
  if (sourceFieldIds.length > AI_SHORTCUT_MAX_SOURCE_FIELDS) {
    fieldConfigError.value = ml('field.error.aiSourceTooMany')
    return { ok: false }
  }
  const options = aiDraft.options.map((option) => option.trim()).filter((option) => option.length > 0)
  if (options.length > AI_SHORTCUT_MAX_OPTIONS) {
    fieldConfigError.value = ml('field.error.aiOptionsTooMany')
    return { ok: false }
  }
  if (options.some((option) => option.length > AI_SHORTCUT_MAX_OPTION_LENGTH)) {
    fieldConfigError.value = ml('field.error.aiOptionTooLong')
    return { ok: false }
  }
  const targetLang = aiDraft.targetLang.trim()
  if (targetLang.length > AI_SHORTCUT_MAX_TARGET_LANG_LENGTH) {
    fieldConfigError.value = ml('field.error.aiTargetLangTooLong')
    return { ok: false }
  }
  const instruction = aiDraft.instruction.trim()
  if (instruction.length > AI_SHORTCUT_MAX_INSTRUCTION_LENGTH) {
    fieldConfigError.value = ml('field.error.aiInstructionTooLong')
    return { ok: false }
  }
  const params: AiShortcutConfigInput['params'] = {
    ...(aiDraft.kind === 'classify' && options.length > 0 ? { options } : {}),
    ...(aiDraft.kind === 'translate' && targetLang ? { targetLang } : {}),
    ...(instruction ? { instruction } : {}),
  }
  return {
    ok: true,
    config: {
      kind: aiDraft.kind,
      sourceFieldIds,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    },
  }
}

// dirty leg for the save no-op skip (mirrors fieldConfigDirty's serialization).
const aiShortcutDirty = computed(() => {
  if (!configTarget.value) return false
  if (!aiShortcutSectionVisible.value) return false
  const baseline = safeParseBaseline(fieldConfigBaseline.value)
  return JSON.stringify(baseline?.aiShortcut ?? null) !== JSON.stringify(serializeAiDraft())
})

function safeParseBaseline(raw: string): { aiShortcut?: unknown } | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as { aiShortcut?: unknown }
  } catch {
    return null
  }
}

// --- A3 §2.1: config-time preview ("用当前记录预览", inline DRAFT config) ---
const aiPreviewRunning = ref(false)
const aiPreviewData = ref<AiShortcutPreviewData | null>(null)
const aiPreviewError = ref('')
let aiPreviewSeq = 0

const aiPreviewCanRun = computed(() =>
  Boolean(props.aiPreviewFn) &&
  Boolean(props.currentRecordId) &&
  aiDraft.enabled &&
  !aiPreviewRunning.value &&
  // Review F3: countdown / cross-surface in-flight → disable, like the drawer.
  !props.aiPreviewBusy,
)

async function runAiPreview() {
  if (!props.aiPreviewFn || !props.currentRecordId || !aiPreviewCanRun.value) return
  fieldConfigError.value = ''
  const resolved = resolveAiShortcutDraft()
  if (!resolved.ok || !resolved.config) return // constraint mirror already set fieldConfigError
  const seq = ++aiPreviewSeq
  aiPreviewRunning.value = true
  aiPreviewError.value = ''
  aiPreviewData.value = null
  try {
    const outcome = await props.aiPreviewFn({ recordId: props.currentRecordId, config: resolved.config })
    if (seq !== aiPreviewSeq) return
    if (!outcome) return // unified in-flight guard refused (another AI request active)
    if ('error' in outcome) {
      if (outcome.error.code === 'VALIDATION_ERROR') {
        // A2 server-side config rejection → the EXISTING fieldConfigError inline (§2.1).
        fieldConfigError.value = outcome.error.message || ml('field.error.aiSourceRequired')
      } else {
        // AI-state errors use the §2.3 copy (fall back to the raw message for unknown codes).
        aiPreviewError.value = aiShortcutErrorMessage(outcome.error.code, isZh.value) ?? outcome.error.message
      }
      return
    }
    aiPreviewData.value = outcome.data
  } finally {
    if (seq === aiPreviewSeq) aiPreviewRunning.value = false
  }
}

const aiPreviewTokensText = computed(() => {
  const usage = aiPreviewData.value?.usage
  if (!usage) return ''
  return aiTokensConsumed(usage.promptTokens + usage.completionTokens, isZh.value)
})

// --- A3 §2.4: admin usage card (403 probe session-cached in useAiShortcut) ---
const aiUsageSummary = ref<AiUsageSummary | null>(null)
let aiUsageSeq = 0

async function loadAiUsageSummary() {
  const fn = props.aiUsageSummaryFn
  if (!fn) return
  const seq = ++aiUsageSeq
  try {
    const summary = await fetchAiUsageSummaryWithProbeCache(fn)
    if (seq === aiUsageSeq) aiUsageSummary.value = summary
  } catch {
    // Non-403 read failure: hide the card quietly — it is admin telemetry,
    // never a blocker for field configuration.
    if (seq === aiUsageSeq) aiUsageSummary.value = null
  }
}

watch(aiShortcutSectionVisible, (visible) => {
  if (visible) void loadAiUsageSummary()
  else aiUsageSummary.value = null
})

function currentDraftProperty(type: MetaFieldCreateType | string): Record<string, unknown> | undefined {
  const normalizedType = type === 'link' || type === 'select' || type === 'multiSelect' || type === 'lookup' || type === 'rollup' || type === 'formula' || type === 'attachment' || type === 'person' || type === 'number' || type === 'currency' || type === 'percent' || type === 'rating' || type === 'autoNumber'
    ? type
    : null
  fieldConfigError.value = ''

  const validationProperty = VALIDATION_PANEL_TYPES.has(type) && validationDraftTouched.value
    ? { validation: rulesToProperty(validationDraft.value) }
    : {}

  if (normalizedType === 'select' || normalizedType === 'multiSelect') {
    const options = selectDraft.options
      .map((option) => ({ value: option.value.trim(), color: option.color.trim() }))
      .filter((option) => option.value.length > 0)
    if (!options.length) {
      fieldConfigError.value = fieldOptionRequired(normalizedType, isZh.value)
      return undefined
    }
    return { options, ...validationProperty }
  }
  if (normalizedType === 'link') {
    if (linkDraft.crossBase) {
      // Cross-base: validate the foreign sheet against the FETCHED foreign-base
      // list (not same-base targetSheets), and require a foreignBaseId. A 403 /
      // transport error on the foreign base blocks the save (fail-closed) — it
      // must NEVER fall through to a same-base property.
      if (
        crossBaseSheetsError.value
        || !linkDraft.foreignBaseId
        || !linkDraft.foreignSheetId
        || !crossBaseSheetOptions.value.some((sheet) => sheet.id === linkDraft.foreignSheetId)
      ) {
        fieldConfigError.value = ml('field.error.linkNeedsCrossBaseTarget')
        return undefined
      }
      // foreignBaseId emitted ONLY when cross-base AND both ids present —
      // mirrors the codec's both-present rule (field-codecs.ts:235).
      return {
        foreignSheetId: linkDraft.foreignSheetId,
        foreignDatasheetId: linkDraft.foreignSheetId,
        foreignBaseId: linkDraft.foreignBaseId,
        limitSingleRecord: linkSingleRecordLockedByHierarchy.value || linkDraft.limitSingleRecord,
      }
    }
    if (!linkDraft.foreignSheetId || !targetSheets.value.some((sheet) => sheet.id === linkDraft.foreignSheetId)) {
      fieldConfigError.value = ml('field.error.linkNeedsTargetSheet')
      return undefined
    }
    // Same-base: unchanged, no foreignBaseId key (backward compatible).
    return {
      foreignSheetId: linkDraft.foreignSheetId,
      foreignDatasheetId: linkDraft.foreignSheetId,
      limitSingleRecord: linkSingleRecordLockedByHierarchy.value || linkDraft.limitSingleRecord,
    }
  }
  if (normalizedType === 'person') {
    return { limitSingleRecord: linkSingleRecordLockedByHierarchy.value || personDraft.limitSingleRecord }
  }
  if (normalizedType === 'lookup') {
    if (!lookupDraft.linkFieldId || !linkSourceFields.value.some((field) => field.id === lookupDraft.linkFieldId) || !lookupDraft.targetFieldId) {
      fieldConfigError.value = ml('field.error.lookupNeedsLinkAndTarget')
      return undefined
    }
    if (lookupDraft.foreignSheetId && !targetSheets.value.some((sheet) => sheet.id === lookupDraft.foreignSheetId)) {
      fieldConfigError.value = ml('field.error.lookupNeedsValidTargetSheet')
      return undefined
    }
    return {
      relatedLinkFieldId: lookupDraft.linkFieldId,
      lookUpTargetFieldId: lookupDraft.targetFieldId,
      ...(lookupDraft.foreignSheetId ? { foreignSheetId: lookupDraft.foreignSheetId } : {}),
    }
  }
  if (normalizedType === 'rollup') {
    if (!rollupDraft.linkFieldId || !linkSourceFields.value.some((field) => field.id === rollupDraft.linkFieldId) || !rollupDraft.targetFieldId) {
      fieldConfigError.value = ml('field.error.rollupNeedsLinkAndTarget')
      return undefined
    }
    if (rollupDraft.foreignSheetId && !targetSheets.value.some((sheet) => sheet.id === rollupDraft.foreignSheetId)) {
      fieldConfigError.value = ml('field.error.rollupNeedsValidTargetSheet')
      return undefined
    }
    return {
      linkedFieldId: rollupDraft.linkFieldId,
      targetFieldId: rollupDraft.targetFieldId,
      aggregation: rollupDraft.aggregation,
      ...(rollupDraft.foreignSheetId ? { foreignSheetId: rollupDraft.foreignSheetId } : {}),
    }
  }
  if (normalizedType === 'formula') {
    const blockingDiagnostic = formulaDiagnostics.value.find((diagnostic) => diagnostic.severity === 'error')
    if (blockingDiagnostic) {
      fieldConfigError.value = blockingDiagnostic.message
      return undefined
    }
    return { expression: formulaDraft.expression.trim() }
  }
  if (normalizedType === 'attachment') {
    return {
      maxFiles: attachmentDraft.maxFiles,
      acceptedMimeTypes: normalizeStringArray(attachmentDraft.acceptedMimeTypesText.split(',')),
    }
  }
  if (normalizedType === 'currency') {
    const code = currencyDraft.code.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) {
      fieldConfigError.value = ml('field.error.currencyCode')
      return undefined
    }
    const decimals = Number(currencyDraft.decimals)
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 6) {
      fieldConfigError.value = ml('field.error.currencyDecimals')
      return undefined
    }
    return { code, decimals: Math.round(decimals) }
  }
  if (normalizedType === 'number') {
    const property: Record<string, unknown> = { ...validationProperty }
    if (numberDraft.decimals !== null) {
      const decimals = Number(numberDraft.decimals)
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 6) {
        fieldConfigError.value = ml('field.error.numberDecimals')
        return undefined
      }
      property.decimals = Math.round(decimals)
    }
    property.thousands = numberDraft.thousands
    const unit = numberDraft.unit.trim()
    if (unit.length > 24) {
      fieldConfigError.value = ml('field.error.numberUnit')
      return undefined
    }
    if (unit) property.unit = unit
    return property
  }
  if (normalizedType === 'percent') {
    const decimals = Number(percentDraft.decimals)
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 6) {
      fieldConfigError.value = ml('field.error.percentDecimals')
      return undefined
    }
    return { decimals: Math.round(decimals) }
  }
  if (normalizedType === 'rating') {
    const max = Number(ratingDraft.max)
    if (!Number.isFinite(max) || max < 1 || max > 10) {
      fieldConfigError.value = ml('field.error.ratingMax')
      return undefined
    }
    return { max: Math.round(max) }
  }
  if (normalizedType === 'autoNumber') {
    const prefix = autoNumberDraft.prefix.trim()
    if (prefix.length > 32) {
      fieldConfigError.value = ml('field.error.autoNumberPrefix')
      return undefined
    }
    const digits = Number(autoNumberDraft.digits)
    if (!Number.isFinite(digits) || digits < 0 || digits > 12) {
      fieldConfigError.value = ml('field.error.autoNumberDigits')
      return undefined
    }
    const start = Number(autoNumberDraft.start)
    if (!Number.isFinite(start) || start < 1) {
      fieldConfigError.value = ml('field.error.autoNumberStart')
      return undefined
    }
    const normalizedStart = Math.floor(start)
    return {
      prefix,
      digits: Math.floor(digits),
      start: normalizedStart,
      startAt: normalizedStart,
    }
  }
  if (type === 'string' || type === 'longText') {
    // A3 CLOBBER GUARD leg 2 (LOCKED §2.1, regression-tested A3-T1b): EVERY
    // string/longText save re-emits the aiShortcut carried by the draft
    // (hydrated from the persisted field), because update-field replaces the
    // property wholesale. Removal = key omission via the enable toggle
    // (A3-T1c) — never `aiShortcut: null` (the backend 400s null).
    const ai = resolveAiShortcutDraft()
    if (!ai.ok) return undefined
    return { ...validationProperty, ...(ai.config ? { aiShortcut: ai.config } : {}) }
  }
  return undefined
}

function insertFormulaField(fieldId: string) {
  formulaDraft.expression = buildFormulaFieldTokenInsertion(formulaDraft.expression, fieldId)
}

function insertFormulaFunction(doc: FormulaFunctionDoc) {
  formulaDraft.expression = buildFormulaFunctionInsertion(formulaDraft.expression, doc)
}

function onAddField() {
  const name = newFieldName.value.trim()
  if (!name) return
  if (addNameConflict.value) return
  if (requiresConfig(newFieldType.value) && !newFieldConfigVisible.value) {
    openNewFieldConfigIfNeeded()
    return
  }
  const property = requiresConfig(newFieldType.value) ? currentDraftProperty(newFieldType.value) : undefined
  if (requiresConfig(newFieldType.value) && !property && fieldConfigError.value) return
  emit('create-field', {
    sheetId: props.sheetId,
    name,
    type: newFieldType.value,
    ...(property ? { property } : {}),
  })
  resetTransientState()
}

function saveConfig() {
  if (!configTarget.value) {
    if (requiresConfig(newFieldType.value)) currentDraftProperty(newFieldType.value)
    return
  }
  if (fieldConfigBlockingReason.value) return
  const fieldType = configDraftType.value ?? displayFieldType(configTarget.value)
  const property = currentDraftProperty(fieldType)
  if (!property && fieldConfigError.value) return
  if (!property) return
  // Skip no-op saves for types that only expose validation + aiShortcut: if
  // the user touched neither surface there is nothing to persist, and
  // emitting an empty `property: {}` would otherwise clobber existing values
  // on the server. Types with mandatory structural config (select/link/
  // lookup/rollup/formula/attachment) always have keys to persist.
  const onlyValidationSurface = (fieldType === 'string' || fieldType === 'longText')
  if (onlyValidationSurface && !validationDraftTouched.value && !aiShortcutDirty.value) {
    closeConfig()
    return
  }
  emit('update-field', configTarget.value.id, { property })
  closeConfig()
}

function startRename(field: MetaField) {
  if (editingId.value !== field.id && !confirmDiscardFieldManagerChanges()) return
  editingId.value = field.id
  editingName.value = field.name
}

function confirmRename(fieldId: string) {
  if (renameNameConflict.value) return
  const name = editingName.value.trim()
  if (name && name !== props.fields.find((field) => field.id === fieldId)?.name) {
    emit('update-field', fieldId, { name })
  }
  cancelRename()
}

function cancelRename() {
  editingId.value = null
  editingName.value = ''
}

function moveField(fieldId: string, newIdx: number) {
  emit('update-field', fieldId, { order: newIdx })
}

function onDeleteField(field: MetaField) {
  deleteTargetId.value = field.id
}

function confirmDelete() {
  if (deleteTarget.value) {
    emit('delete-field', deleteTarget.value.id)
    deleteTargetId.value = null
  }
}

const fieldConfigDirty = computed(() => {
  if (!configTarget.value) return false
  return serializeFieldDraft(configDraftType.value) !== fieldConfigBaseline.value
})

const newFieldDraftDirty = computed(() => {
  if (!requiresConfig(newFieldType.value) || !newFieldConfigVisible.value) return false
  return serializeFieldDraft(newFieldType.value) !== fieldConfigBaseline.value
})

const renameDirty = computed(() => {
  if (!editingId.value) return false
  return editingName.value.trim() !== (props.fields.find((field) => field.id === editingId.value)?.name ?? '')
})

const hasPendingDrafts = computed(() => fieldConfigDirty.value ||
  renameDirty.value ||
  newFieldName.value.trim().length > 0 ||
  newFieldType.value !== 'string' ||
  newFieldDraftDirty.value)

const managerDirty = computed(() => props.visible && hasPendingDrafts.value)

function confirmDiscardFieldManagerChanges() {
  if (!hasPendingDrafts.value) return true
  return window.confirm(ml('field.discardManagerConfirm'))
}

function reloadLatestConfig() {
  if (!configTarget.value) return
  hydrateExistingFieldConfig(configTarget.value)
}

function dismissLiveRefreshNotice() {
  fieldConfigLiveRefreshText.value = ''
}

function addSelectOption() {
  selectDraft.options.push({ value: '', color: '' })
}

function removeSelectOption(index: number) {
  if (selectDraft.options.length === 1) {
    selectDraft.options.splice(0, 1, { value: '', color: '' })
    return
  }
  selectDraft.options.splice(index, 1)
}

function openConfig(field: MetaField) {
  if (configTargetId.value && configTargetId.value !== field.id && !confirmDiscardFieldManagerChanges()) return
  hydrateExistingFieldConfig(field)
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) resetTransientState()
  },
)

watch(
  [() => props.fields, () => props.sheets, () => props.sheetId, () => configTargetId.value, () => deleteTargetId.value, () => editingId.value],
  () => {
    if (configTargetId.value && !configTarget.value) closeConfig()
    else if (configTarget.value) {
      const latestSignature = serializeFieldSourceSignature(configTarget.value)
      if (latestSignature !== fieldConfigSourceSignature.value) {
        if (fieldConfigDirty.value) {
          fieldConfigOutdated.value = true
          fieldConfigLiveRefreshText.value = ''
        } else {
          hydrateExistingFieldConfig(configTarget.value, {
            liveRefreshText: ml('field.latestMetadataLoaded'),
          })
        }
      }
    }
    if (deleteTargetId.value && !deleteTarget.value) deleteTargetId.value = null
    if (editingId.value && !props.fields.some((field) => field.id === editingId.value)) cancelRename()
  },
)

watch(
  fieldConfigDirty,
  (dirty) => {
    if (dirty) fieldConfigLiveRefreshText.value = ''
  },
)

watch(
  managerDirty,
  (dirty) => {
    emit('update:dirty', dirty)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  emit('update:dirty', false)
})
</script>

<style scoped>
.meta-field-mgr__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-field-mgr { width: 720px; max-height: 84vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-field-mgr__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-field-mgr__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-field-mgr__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-field-mgr__body { flex: 1; overflow-y: auto; padding: 8px 16px; }
.meta-field-mgr__row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
.meta-field-mgr__icon { width: 24px; text-align: center; color: #999; font-size: 13px; }
.meta-field-mgr__name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-field-mgr__type { font-size: 11px; color: #999; background: #f5f5f5; padding: 1px 6px; border-radius: 3px; }
.meta-field-mgr__rename { flex: 1; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px; font-size: 13px; }
.meta-field-mgr__action { border: none; background: none; color: #999; cursor: pointer; font-size: 13px; padding: 2px 4px; }
.meta-field-mgr__action:hover { color: #333; }
.meta-field-mgr__action:disabled { opacity: 0.3; cursor: not-allowed; }
.meta-field-mgr__action--ok { color: #67c23a; }
.meta-field-mgr__action--danger:hover { color: #f56c6c; }
.meta-field-mgr__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-field-mgr__config { padding: 14px 16px; border-top: 1px solid #eee; background: #fbfdff; display: flex; flex-direction: column; gap: 12px; }
.meta-field-mgr__config-header { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #666; }
.meta-field-mgr__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #666; }
.meta-field-mgr__toggle { display: flex; gap: 8px; align-items: center; font-size: 12px; color: #444; }
.meta-field-mgr__hint { padding: 8px 10px; border: 1px solid #d9ecff; border-radius: 6px; background: #ecf5ff; color: #4a6785; font-size: 12px; }
.meta-field-mgr__hint--error { border-color: #fbc4c4; background: #fef0f0; color: #a8323f; }
.meta-field-mgr__warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid #f3d19e; border-radius: 6px; background: #fff7e6; color: #8a5a00; font-size: 12px; }
.meta-field-mgr__refresh { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid #bfd6ff; border-radius: 6px; background: #eef5ff; color: #1d4ed8; font-size: 12px; }
.meta-field-mgr__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-field-mgr__chip { border: 1px solid #d9ecff; border-radius: 999px; background: #f0f7ff; color: #2563eb; padding: 3px 10px; cursor: pointer; font-size: 11px; }
.meta-field-mgr__formula-diagnostics { display: flex; flex-direction: column; gap: 4px; }
.meta-field-mgr__formula-diagnostic { padding: 6px 8px; border-radius: 5px; font-size: 12px; }
.meta-field-mgr__formula-diagnostic--warning { background: #fff7e6; color: #8a5a00; border: 1px solid #f3d19e; }
.meta-field-mgr__formula-diagnostic--error { background: #fef0f0; color: #c0392b; border: 1px solid #fbc4c4; }
.meta-field-mgr__formula-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 8px; }
.meta-field-mgr__formula-docs { display: flex; flex-direction: column; gap: 10px; max-height: 220px; overflow-y: auto; }
.meta-field-mgr__formula-section { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.meta-field-mgr__formula-section-title { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; color: #334155; }
.meta-field-mgr__formula-section-title strong { font-size: 12px; color: #0f172a; }
.meta-field-mgr__formula-section-title span { font-size: 11px; color: #64748b; }
.meta-field-mgr__formula-doc { display: flex; flex-direction: column; gap: 3px; padding: 8px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; color: #334155; text-align: left; cursor: pointer; }
.meta-field-mgr__formula-doc:hover { border-color: #93c5fd; background: #f8fbff; }
.meta-field-mgr__formula-doc strong { font-size: 12px; color: #1d4ed8; }
.meta-field-mgr__formula-doc span { font-size: 11px; color: #64748b; }
.meta-field-mgr__formula-doc code { font-size: 11px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta-field-mgr__formula-empty { padding: 8px; border: 1px dashed #cbd5e1; border-radius: 6px; color: #64748b; background: #fff; font-size: 12px; }
.meta-field-mgr__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.meta-field-mgr__stack { display: flex; flex-direction: column; gap: 8px; }
.meta-field-mgr__option-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; }
.meta-field-mgr__add-section { padding: 10px 16px; border-top: 1px solid #eee; }
.meta-field-mgr__add-row { display: flex; gap: 8px; }
.meta-field-mgr__input, .meta-field-mgr__select, .meta-field-mgr__textarea { width: 100%; padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; background: #fff; }
.meta-field-mgr__textarea { min-height: 88px; resize: vertical; }
.meta-field-mgr__btn-add { padding: 5px 14px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.meta-field-mgr__btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-field-mgr__btn-add:hover:not(:disabled) { background: #66b1ff; }
.meta-field-mgr__btn-inline { align-self: flex-start; padding: 4px 10px; border: 1px dashed #cbd5e1; border-radius: 4px; background: #fff; color: #475569; cursor: pointer; font-size: 12px; }
.meta-field-mgr__confirm { padding: 12px 16px; border-top: 1px solid #eee; background: #fef0f0; }
.meta-field-mgr__confirm p { margin: 0 0 8px; font-size: 13px; color: #333; }
.meta-field-mgr__confirm-actions, .meta-field-mgr__config-actions { display: flex; gap: 8px; justify-content: flex-end; }
.meta-field-mgr__btn-cancel { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-field-mgr__btn-delete { padding: 4px 12px; background: #f56c6c; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
.meta-field-mgr__error { color: #f56c6c; font-size: 12px; }
.meta-field-mgr__validation { margin-top: 4px; }
/* A3: AI shortcut config section */
.meta-field-mgr__ai { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border: 1px solid #e0e7ff; border-radius: 8px; background: #fafbff; }
.meta-field-mgr__ai-header { font-size: 12px; color: #4338ca; }
.meta-field-mgr__ai-sources { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.meta-field-mgr__ai-source { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #444; }
/* r2 item 6: all-sources-deleted needs-attention banner ON the AI section. */
.meta-field-mgr__ai-source-deleted-warning {
  margin: 6px 0 0;
  padding: 6px 8px;
  border: 1px solid #f0c36d;
  border-radius: 6px;
  background: #fdf6ec;
  color: #b45309;
  font-size: 12px;
}
.meta-field-mgr__ai-preview { display: flex; flex-direction: column; gap: 6px; }
.meta-field-mgr__ai-preview-output { font-size: 12px; color: #334155; white-space: pre-wrap; word-break: break-word; }
/* §2.4 admin usage card — automation stats-card styling family
   (MetaAutomationManager .meta-automation__card-stats / __stat). */
.meta-field-mgr__ai-usage { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; font-size: 12px; }
.meta-field-mgr__ai-usage-stats { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; }
.meta-field-mgr__ai-stat { font-weight: 600; }
.meta-field-mgr__ai-stat--day { color: #16a34a; }
.meta-field-mgr__ai-stat--week { color: #1d4ed8; }
.meta-field-mgr__ai-stat--usd { color: #b45309; }
.meta-field-mgr__rename-wrap { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.meta-field-mgr__rename--invalid { border-color: #f56c6c; }
.meta-field-mgr__input--invalid { border-color: #f56c6c; }
.meta-field-mgr__inline-error { color: #f56c6c; font-size: 11px; margin-top: 4px; }
</style>
