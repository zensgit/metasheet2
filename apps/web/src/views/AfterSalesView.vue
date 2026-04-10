<template>
  <section class="after-sales-view">
    <div v-if="loading || installing" class="after-sales-view__overlay">
      <div class="after-sales-view__overlay-card">
        <div class="after-sales-view__spinner" />
        <h2>{{ installing ? 'Initializing After Sales' : 'Loading After Sales' }}</h2>
        <p>{{ installing ? '正在初始化售后模板...' : '正在读取当前安装状态...' }}</p>
      </div>
    </div>

    <header class="after-sales-view__hero">
      <div>
        <p class="after-sales-view__eyebrow">Platform App</p>
        <h1>{{ current.displayName || manifest?.displayName || 'After Sales' }}</h1>
        <p class="after-sales-view__lead">
          售后应用已经接入项目安装器。这里会根据当前安装状态切换为启用引导、运行概览或故障恢复页。
        </p>
      </div>
      <div class="after-sales-view__hero-actions">
        <div class="after-sales-view__status" :data-tone="statusTone">
          {{ statusLabel }}
        </div>
        <button class="after-sales-view__ghost-btn" :disabled="loading || installing || refreshing" @click="refreshCurrentState">
          {{ refreshing ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>
    </header>

    <section v-if="error" class="after-sales-view__error-banner">
      <div>
        <strong>After-sales request failed</strong>
        <p>{{ error }}</p>
      </div>
      <button class="after-sales-view__primary-btn" :disabled="loading || installing" @click="loadView">
        Retry
      </button>
    </section>

    <section class="after-sales-view__config-shell">
      <article class="after-sales-view__card">
        <div class="after-sales-view__section-header">
          <div>
            <p class="after-sales-view__pill">Config draft</p>
            <h2>Minimal config editor</h2>
            <p>
              这里编辑的是下一次 install / reinstall 会提交的草稿。当前只暴露最小字段，保留其余默认配置。
            </p>
          </div>
          <button class="after-sales-view__ghost-btn" :disabled="loading || installing || refreshing" @click="resetConfigDraft">
            Reset to loaded config
          </button>
        </div>

        <form class="after-sales-view__config-form" @submit.prevent>
          <label class="after-sales-view__field">
            <span>Default SLA hours</span>
            <input v-model.number="configDraft.defaultSlaHours" class="after-sales-view__field-input" min="1" step="1" type="number" />
          </label>
          <label class="after-sales-view__field">
            <span>Urgent SLA hours</span>
            <input v-model.number="configDraft.urgentSlaHours" class="after-sales-view__field-input" min="1" step="1" type="number" />
          </label>
          <label class="after-sales-view__field">
            <span>Follow-up days</span>
            <input v-model.number="configDraft.followUpAfterDays" class="after-sales-view__field-input" min="1" step="1" type="number" />
          </label>
          <label class="after-sales-view__field after-sales-view__field--wide">
            <span>Overdue webhook</span>
            <input
              v-model="configDraft.overdueWebhook"
              class="after-sales-view__field-input"
              placeholder="https://example.test/hooks/after-sales"
              type="url"
            />
          </label>
        </form>

        <p class="after-sales-view__config-hint">
          Install payload still targets the placeholder project ID <code>{{ placeholderProjectId }}</code>.
        </p>
      </article>
    </section>

    <section v-if="current.status === 'not-installed'" class="after-sales-view__onboarding">
      <article class="after-sales-view__onboarding-card">
        <p class="after-sales-view__pill">v1 Project Enablement</p>
        <h2>Enable the after-sales project shell</h2>
        <p>
          这一步会创建售后项目的账本记录，并通过 multitable provisioning seam 落下最小售后数据投影。
        </p>
        <ul class="after-sales-view__list">
          <li>templateId 固定为 <code>after-sales-default</code></li>
          <li>v1 projectId 伪值为 <code>{{ placeholderProjectId }}</code></li>
          <li>当前会真实创建售后模板的 6 个默认对象，覆盖工单、装机资产、客户、服务记录、配件和回访</li>
          <li>同时会创建 6 个默认视图，包括 <code>ticket-board</code>、<code>serviceRecord-calendar</code> 等基础入口</li>
        </ul>
        <div class="after-sales-view__action-row">
          <button class="after-sales-view__primary-btn" :disabled="installing" @click="triggerInstall('enable')">
            Enable After Sales
          </button>
        </div>
      </article>

      <article class="after-sales-view__card">
        <h2>Platform dependencies</h2>
        <ul v-if="manifest?.platformDependencies?.length" class="after-sales-view__list">
          <li v-for="item in manifest.platformDependencies" :key="item">{{ item }}</li>
        </ul>
        <p v-else>No manifest data loaded.</p>
      </article>
    </section>

    <section v-else class="after-sales-view__content">
      <section v-if="isDegraded" class="after-sales-view__warning-banner" :data-tone="current.status">
        <div>
          <strong>{{ current.status === 'failed' ? 'Initialization failed' : 'Initialization completed with warnings' }}</strong>
          <p>
            {{ current.status === 'failed'
              ? '账本里已有 failed 终态，重试会走 reinstall。'
              : 'partial 状态允许继续进入首页，但建议尽快执行 reinstall 补齐缺失对象。' }}
          </p>
        </div>
        <div class="after-sales-view__action-row">
          <button class="after-sales-view__primary-btn" :disabled="installing" @click="triggerInstall('reinstall')">
            Reinstall
          </button>
          <button class="after-sales-view__ghost-btn" :disabled="warnings.length === 0" @click="showWarnings = true">
            Warnings
          </button>
        </div>
      </section>

      <section v-if="isInstalled" class="after-sales-view__tickets-shell">
        <article class="after-sales-view__card after-sales-view__card--wide">
          <div class="after-sales-view__section-header">
            <div>
              <p class="after-sales-view__pill">Tickets</p>
              <h2>Recent tickets</h2>
              <p>
                这里显示最近的售后工单，并在退款申请处于 pending 时尽量补充审批状态。
              </p>
            </div>
          </div>

          <form class="after-sales-view__ticket-form" @submit.prevent="submitTicket">
            <label class="after-sales-view__field">
              <span>Ticket no</span>
              <input
                id="after-sales-ticket-no"
                v-model="ticketDraft.ticketNo"
                class="after-sales-view__field-input"
                placeholder="TK-3001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Priority</span>
              <select id="after-sales-ticket-priority" v-model="ticketDraft.priority" class="after-sales-view__field-input">
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Title</span>
              <input
                id="after-sales-ticket-title"
                v-model="ticketDraft.title"
                class="after-sales-view__field-input"
                placeholder="Broken compressor"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Source</span>
              <select id="after-sales-ticket-source" v-model="ticketDraft.source" class="after-sales-view__field-input">
                <option value="web">Web</option>
                <option value="phone">Phone</option>
                <option value="wechat">WeChat</option>
              </select>
            </label>
            <label v-if="!isRefundAmountHidden" class="after-sales-view__field">
              <span>Refund amount</span>
              <input
                id="after-sales-ticket-refund-amount"
                v-model="ticketDraft.refundAmount"
                class="after-sales-view__field-input"
                :disabled="!isRefundAmountEditable"
                inputmode="decimal"
                placeholder="optional"
                type="text"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__primary-btn"
              :disabled="ticketCreating || ticketsLoading || Boolean(ticketUpdatingId) || !canSubmitTicket"
              @click="submitTicket"
            >
              {{ ticketCreating ? 'Creating...' : 'Create ticket' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="ticketCreating || ticketsLoading || Boolean(ticketUpdatingId)"
              @click="resetTicketDraft"
            >
              Reset ticket draft
            </button>
          </div>

          <p v-if="ticketDraftError || ticketSubmitError" class="after-sales-view__inline-error">
            {{ ticketDraftError || ticketSubmitError }}
          </p>
          <p v-else-if="ticketSubmitSuccess" class="after-sales-view__inline-success">{{ ticketSubmitSuccess }}</p>

          <form class="after-sales-view__ticket-filters" @submit.prevent="applyTicketFilters">
            <label class="after-sales-view__field">
              <span>Filter status</span>
              <input
                id="after-sales-ticket-filter-status"
                v-model="ticketFilters.status"
                class="after-sales-view__field-input"
                placeholder="open, pending..."
                type="text"
              />
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Search ticket</span>
              <input
                id="after-sales-ticket-filter-search"
                v-model="ticketFilters.search"
                class="after-sales-view__field-input"
                placeholder="ticket no, title, refund status..."
                type="text"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__ghost-btn"
              :disabled="ticketsLoading || ticketCreating || Boolean(ticketDeletingId) || Boolean(ticketUpdatingId) || Boolean(ticketEditingId)"
              @click="refreshTickets"
            >
              {{ ticketsLoading ? 'Refreshing...' : 'Refresh list' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="ticketsLoading || Boolean(ticketUpdatingId) || Boolean(ticketEditingId)"
              @click="applyTicketFilters"
            >
              {{ ticketsLoading ? 'Applying...' : 'Apply ticket filters' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="ticketsLoading || Boolean(ticketUpdatingId) || Boolean(ticketEditingId)"
              @click="resetTicketFilters"
            >
              Clear ticket filters
            </button>
          </div>
          <p v-if="ticketsLoading" class="after-sales-view__muted-state">Loading recent tickets...</p>
          <p v-else-if="ticketsError" class="after-sales-view__inline-error">{{ ticketsError }}</p>
          <div v-else-if="tickets.length" class="after-sales-view__ticket-list">
            <article v-for="ticket in tickets" :key="ticket.id" class="after-sales-view__ticket-row">
              <div class="after-sales-view__ticket-main">
                <template v-if="ticketEditingId === ticket.id">
                  <div class="after-sales-view__ticket-headline">
                    <strong>{{ ticket.data.ticketNo }}</strong>
                    <span class="after-sales-view__tag">{{ ticketEditDraft.status }}</span>
                    <span class="after-sales-view__tag after-sales-view__tag--subtle">
                      {{ ticket.data.refundStatus || 'n/a' }}
                    </span>
                  </div>
                  <form class="after-sales-view__ticket-form after-sales-view__ticket-form--inline" @submit.prevent="submitTicketEdit(ticket)">
                    <label class="after-sales-view__field after-sales-view__field--wide">
                      <span>Title</span>
                      <input
                        :id="`after-sales-ticket-edit-title-${ticket.id}`"
                        v-model="ticketEditDraft.title"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Priority</span>
                      <select
                        :id="`after-sales-ticket-edit-priority-${ticket.id}`"
                        v-model="ticketEditDraft.priority"
                        class="after-sales-view__field-input"
                      >
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field">
                      <span>Source</span>
                      <select
                        :id="`after-sales-ticket-edit-source-${ticket.id}`"
                        v-model="ticketEditDraft.source"
                        class="after-sales-view__field-input"
                      >
                        <option value="web">Web</option>
                        <option value="phone">Phone</option>
                        <option value="wechat">WeChat</option>
                        <option value="email">Email</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field">
                      <span>Status</span>
                      <select
                        :id="`after-sales-ticket-edit-status-${ticket.id}`"
                        v-model="ticketEditDraft.status"
                        class="after-sales-view__field-input"
                      >
                        <option value="new">New</option>
                        <option value="assigned">Assigned</option>
                        <option value="inProgress">In progress</option>
                        <option value="done">Done</option>
                        <option value="closed">Closed</option>
                      </select>
                    </label>
                  </form>
                </template>
                <template v-else>
                  <div class="after-sales-view__ticket-headline">
                    <strong>{{ ticket.data.ticketNo }}</strong>
                    <span class="after-sales-view__tag">{{ ticket.data.status }}</span>
                    <span class="after-sales-view__tag after-sales-view__tag--subtle">
                      {{ ticket.data.refundStatus || 'n/a' }}
                    </span>
                  </div>
                  <p>{{ ticket.data.title }}</p>
                </template>
              </div>

              <div class="after-sales-view__ticket-side">
                <dl class="after-sales-view__ticket-meta">
                  <div v-if="!isRefundAmountHidden">
                    <dt>Refund amount</dt>
                    <dd>{{ formatRefundAmount(ticket.data.refundAmount) }}</dd>
                  </div>
                  <div>
                    <dt>Approval</dt>
                    <dd>{{ ticket.approvalLabel }}</dd>
                  </div>
                </dl>
                <div v-if="ticketEditingId === ticket.id" class="after-sales-view__ticket-actions">
                  <button
                    class="after-sales-view__primary-btn after-sales-view__ticket-action-btn"
                    :disabled="ticketUpdatingId === ticket.id || ticketsLoading || !canSubmitTicketEdit"
                    @click="submitTicketEdit(ticket)"
                  >
                    {{ ticketUpdatingId === ticket.id ? 'Saving...' : 'Save changes' }}
                  </button>
                  <button
                    class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                    :disabled="ticketUpdatingId === ticket.id"
                    @click="cancelTicketEdit"
                  >
                    Cancel edit
                  </button>
                </div>
                <div v-else class="after-sales-view__ticket-actions">
                  <label v-if="!isRefundAmountHidden" class="after-sales-view__field after-sales-view__field--compact">
                    <span>Refund request</span>
                    <input
                      :id="`after-sales-ticket-refund-request-${ticket.id}`"
                      :value="ticketRefundDrafts[ticket.id] ?? formatRefundDraft(ticket.data.refundAmount)"
                      class="after-sales-view__field-input"
                      :disabled="!isRefundAmountEditable"
                      inputmode="decimal"
                      placeholder="88.5"
                      type="text"
                      @input="updateTicketRefundDraft(ticket.id, $event)"
                    />
                  </label>
                  <button
                    v-if="!isRefundAmountHidden"
                    class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                    :disabled="ticketCreating || ticketsLoading || ticketDeletingId === ticket.id || ticketRefundSubmittingId === ticket.id || ticketUpdatingId === ticket.id || !isRefundAmountEditable"
                    @click="requestTicketRefund(ticket)"
                  >
                    {{ ticketRefundSubmittingId === ticket.id ? 'Requesting...' : 'Request refund' }}
                  </button>
                </div>
                <button
                  v-if="ticketEditingId !== ticket.id"
                  class="after-sales-view__ghost-btn after-sales-view__ticket-delete"
                  :aria-label="`Edit ticket ${ticket.data.ticketNo}`"
                  :disabled="Boolean(ticketDeletingId) || Boolean(ticketUpdatingId) || Boolean(ticketEditingId) || ticketRefundSubmittingId === ticket.id"
                  @click="startTicketEdit(ticket)"
                >
                  Edit
                </button>
                <button
                  class="after-sales-view__ghost-btn after-sales-view__ticket-delete"
                  :aria-label="`Delete ticket ${ticket.data.ticketNo}`"
                  :disabled="Boolean(ticketDeletingId) || Boolean(ticketUpdatingId) || ticketRefundSubmittingId === ticket.id || ticketEditingId === ticket.id"
                  @click="deleteTicket(ticket)"
                >
                  {{ ticketDeletingId === ticket.id ? 'Deleting...' : 'Delete' }}
                </button>
                <p
                  v-if="ticketRefundErrorById[ticket.id]"
                  class="after-sales-view__inline-error after-sales-view__inline-error--compact"
                >
                  {{ ticketRefundErrorById[ticket.id] }}
                </p>
              </div>
            </article>
          </div>
          <p v-else class="after-sales-view__muted-state">No tickets found yet.</p>
        </article>
      </section>

      <section v-if="isInstalled" class="after-sales-view__installed-assets-shell">
        <article class="after-sales-view__card after-sales-view__card--wide">
          <div class="after-sales-view__section-header">
            <div>
              <p class="after-sales-view__pill">Installed assets</p>
              <h2>Installed asset registry</h2>
              <p>
                这里显示已登记的设备资产，便于在工单和上门记录之前先确认设备主数据是否已经建档。
              </p>
            </div>
          </div>

          <form class="after-sales-view__installed-asset-form" @submit.prevent="submitInstalledAsset">
            <label class="after-sales-view__field">
              <span>Asset code</span>
              <input
                id="after-sales-installed-asset-code"
                v-model="installedAssetDraft.assetCode"
                class="after-sales-view__field-input"
                placeholder="AST-3001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Status</span>
              <select
                id="after-sales-installed-asset-status"
                v-model="installedAssetDraft.status"
                class="after-sales-view__field-input"
              >
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="decommissioned">Decommissioned</option>
              </select>
            </label>
            <label class="after-sales-view__field">
              <span>Serial no</span>
              <input
                id="after-sales-installed-asset-serial-no"
                v-model="installedAssetDraft.serialNo"
                class="after-sales-view__field-input"
                placeholder="SN-3001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Model</span>
              <input
                id="after-sales-installed-asset-model"
                v-model="installedAssetDraft.model"
                class="after-sales-view__field-input"
                placeholder="Compressor X"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Location</span>
              <input
                id="after-sales-installed-asset-location"
                v-model="installedAssetDraft.location"
                class="after-sales-view__field-input"
                placeholder="Plant 1"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Installed at</span>
              <input
                id="after-sales-installed-asset-installed-at"
                v-model="installedAssetDraft.installedAt"
                class="after-sales-view__field-input"
                type="datetime-local"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Warranty until</span>
              <input
                id="after-sales-installed-asset-warranty-until"
                v-model="installedAssetDraft.warrantyUntil"
                class="after-sales-view__field-input"
                type="date"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__primary-btn"
              :disabled="installedAssetCreating || installedAssetsLoading || Boolean(installedAssetDeletingId) || Boolean(installedAssetUpdatingId) || Boolean(installedAssetEditingId) || !canSubmitInstalledAsset"
              @click="submitInstalledAsset"
            >
              {{ installedAssetCreating ? 'Creating...' : 'Create asset' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="installedAssetCreating || installedAssetsLoading || Boolean(installedAssetDeletingId) || Boolean(installedAssetUpdatingId) || Boolean(installedAssetEditingId)"
              @click="resetInstalledAssetDraft"
            >
              Reset asset draft
            </button>
          </div>

          <p v-if="installedAssetSubmitError" class="after-sales-view__inline-error">{{ installedAssetSubmitError }}</p>
          <p v-else-if="installedAssetSubmitSuccess" class="after-sales-view__inline-success">{{ installedAssetSubmitSuccess }}</p>

          <form class="after-sales-view__installed-asset-filters" @submit.prevent="applyInstalledAssetFilters">
            <label class="after-sales-view__field">
              <span>Filter status</span>
              <select
                id="after-sales-installed-asset-filter-status"
                v-model="installedAssetFilters.status"
                class="after-sales-view__field-input"
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="decommissioned">Decommissioned</option>
              </select>
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Search asset</span>
              <input
                id="after-sales-installed-asset-filter-search"
                v-model="installedAssetFilters.search"
                class="after-sales-view__field-input"
                placeholder="asset code, serial no, model, location..."
                type="text"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__ghost-btn"
              :disabled="installedAssetsLoading || installedAssetCreating || Boolean(installedAssetDeletingId) || Boolean(installedAssetUpdatingId) || Boolean(installedAssetEditingId)"
              @click="refreshInstalledAssets"
            >
              {{ installedAssetsLoading ? 'Refreshing...' : 'Refresh list' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="installedAssetsLoading || installedAssetCreating || Boolean(installedAssetDeletingId) || Boolean(installedAssetUpdatingId) || Boolean(installedAssetEditingId)"
              @click="applyInstalledAssetFilters"
            >
              {{ installedAssetsLoading ? 'Applying...' : 'Apply filters' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="installedAssetsLoading || installedAssetCreating || Boolean(installedAssetDeletingId) || Boolean(installedAssetUpdatingId) || Boolean(installedAssetEditingId)"
              @click="resetInstalledAssetFilters"
            >
              Clear filters
            </button>
          </div>

          <p v-if="installedAssetsLoading" class="after-sales-view__muted-state">Loading installed assets...</p>
          <p v-else-if="installedAssetsError" class="after-sales-view__inline-error">{{ installedAssetsError }}</p>
          <div v-else-if="installedAssets.length" class="after-sales-view__installed-asset-list">
            <article v-for="asset in installedAssets" :key="asset.id" class="after-sales-view__installed-asset-row">
              <div class="after-sales-view__installed-asset-main">
                <template v-if="installedAssetEditingId === asset.id">
                  <div class="after-sales-view__installed-asset-headline">
                    <strong>{{ installedAssetEditDraft.assetCode || asset.data.assetCode }}</strong>
                    <span class="after-sales-view__tag">{{ installedAssetEditDraft.status }}</span>
                    <span v-if="installedAssetEditDraft.serialNo" class="after-sales-view__tag after-sales-view__tag--subtle">
                      {{ installedAssetEditDraft.serialNo }}
                    </span>
                  </div>
                  <form class="after-sales-view__installed-asset-form after-sales-view__ticket-form--inline" @submit.prevent="submitInstalledAssetEdit(asset)">
                    <label class="after-sales-view__field">
                      <span>Asset code</span>
                      <input
                        :id="`after-sales-installed-asset-edit-asset-code-${asset.id}`"
                        v-model="installedAssetEditDraft.assetCode"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Status</span>
                      <select
                        :id="`after-sales-installed-asset-edit-status-${asset.id}`"
                        v-model="installedAssetEditDraft.status"
                        class="after-sales-view__field-input"
                      >
                        <option value="active">Active</option>
                        <option value="expired">Expired</option>
                        <option value="decommissioned">Decommissioned</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field">
                      <span>Serial no</span>
                      <input
                        :id="`after-sales-installed-asset-edit-serial-no-${asset.id}`"
                        v-model="installedAssetEditDraft.serialNo"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Model</span>
                      <input
                        :id="`after-sales-installed-asset-edit-model-${asset.id}`"
                        v-model="installedAssetEditDraft.model"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Location</span>
                      <input
                        :id="`after-sales-installed-asset-edit-location-${asset.id}`"
                        v-model="installedAssetEditDraft.location"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Installed at</span>
                      <input
                        :id="`after-sales-installed-asset-edit-installed-at-${asset.id}`"
                        v-model="installedAssetEditDraft.installedAt"
                        class="after-sales-view__field-input"
                        type="datetime-local"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Warranty until</span>
                      <input
                        :id="`after-sales-installed-asset-edit-warranty-until-${asset.id}`"
                        v-model="installedAssetEditDraft.warrantyUntil"
                        class="after-sales-view__field-input"
                        type="date"
                      />
                    </label>
                  </form>
                </template>
                <template v-else>
                  <div class="after-sales-view__installed-asset-headline">
                    <strong>{{ asset.data.assetCode }}</strong>
                    <span class="after-sales-view__tag">{{ asset.data.status }}</span>
                    <span v-if="asset.data.serialNo" class="after-sales-view__tag after-sales-view__tag--subtle">
                      {{ asset.data.serialNo }}
                    </span>
                  </div>
                  <p>{{ asset.data.model || 'Model not set yet.' }}</p>
                </template>
              </div>

              <div class="after-sales-view__installed-asset-side">
                <dl class="after-sales-view__installed-asset-meta">
                  <div>
                    <dt>Location</dt>
                    <dd>{{ asset.data.location || 'Unknown' }}</dd>
                  </div>
                  <div>
                    <dt>Installed</dt>
                    <dd>{{ formatRecordDate(asset.data.installedAt) }}</dd>
                  </div>
                  <div>
                    <dt>Warranty</dt>
                    <dd>{{ formatRecordDate(asset.data.warrantyUntil) }}</dd>
                  </div>
                </dl>
                <div v-if="installedAssetEditingId === asset.id" class="after-sales-view__ticket-actions">
                  <button
                    class="after-sales-view__primary-btn after-sales-view__ticket-action-btn"
                    :disabled="installedAssetUpdatingId === asset.id || installedAssetsLoading || !canSubmitInstalledAssetEdit"
                    @click="submitInstalledAssetEdit(asset)"
                  >
                    {{ installedAssetUpdatingId === asset.id ? 'Saving...' : 'Save changes' }}
                  </button>
                  <button
                    class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                    :disabled="installedAssetUpdatingId === asset.id"
                    @click="cancelInstalledAssetEdit"
                  >
                    Cancel edit
                  </button>
                </div>
                <button
                  v-if="installedAssetEditingId !== asset.id"
                  class="after-sales-view__ghost-btn after-sales-view__installed-asset-delete"
                  :aria-label="`Edit installed asset ${asset.data.assetCode}`"
                  :disabled="Boolean(installedAssetDeletingId) || Boolean(installedAssetUpdatingId) || Boolean(installedAssetEditingId)"
                  @click="startInstalledAssetEdit(asset)"
                >
                  Edit
                </button>
                <button
                  class="after-sales-view__ghost-btn after-sales-view__installed-asset-delete"
                  :aria-label="`Delete installed asset ${asset.data.assetCode}`"
                  :disabled="installedAssetDeletingId === asset.id || installedAssetCreating || installedAssetsLoading || Boolean(installedAssetUpdatingId) || installedAssetEditingId === asset.id"
                  @click="deleteInstalledAsset(asset)"
                >
                  {{ installedAssetDeletingId === asset.id ? 'Deleting...' : 'Delete' }}
                </button>
              </div>
            </article>
          </div>
          <p v-else class="after-sales-view__muted-state">No installed assets found yet.</p>
        </article>
      </section>

      <section v-if="isInstalled" class="after-sales-view__service-records-shell">
        <article class="after-sales-view__card after-sales-view__card--wide">
          <div class="after-sales-view__section-header">
            <div>
              <p class="after-sales-view__pill">Service records</p>
              <h2>Recent visits</h2>
              <p>
                这里显示最近的上门/远程服务记录，便于确认工单已经进入现场执行阶段。
              </p>
            </div>
          </div>

          <form class="after-sales-view__service-record-form" @submit.prevent="submitServiceRecord">
            <label class="after-sales-view__field">
              <span>Ticket no</span>
              <input
                id="after-sales-service-record-ticket-no"
                v-model="serviceRecordDraft.ticketNo"
                class="after-sales-view__field-input"
                list="after-sales-service-record-ticket-options"
                placeholder="AF-001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Visit type</span>
              <select
                id="after-sales-service-record-visit-type"
                v-model="serviceRecordDraft.visitType"
                class="after-sales-view__field-input"
              >
                <option value="onsite">Onsite</option>
                <option value="remote">Remote</option>
                <option value="pickup">Pickup</option>
              </select>
            </label>
            <label class="after-sales-view__field">
              <span>Scheduled at</span>
              <input
                id="after-sales-service-record-scheduled-at"
                v-model="serviceRecordDraft.scheduledAt"
                class="after-sales-view__field-input"
                type="datetime-local"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Completed at</span>
              <input
                id="after-sales-service-record-completed-at"
                v-model="serviceRecordDraft.completedAt"
                class="after-sales-view__field-input"
                type="datetime-local"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Technician</span>
              <input
                id="after-sales-service-record-technician"
                v-model="serviceRecordDraft.technicianName"
                class="after-sales-view__field-input"
                placeholder="Technician name"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Result</span>
              <select
                id="after-sales-service-record-result"
                v-model="serviceRecordDraft.result"
                class="after-sales-view__field-input"
              >
                <option value="">Pending</option>
                <option value="resolved">Resolved</option>
                <option value="partial">Partial</option>
                <option value="escalated">Escalated</option>
              </select>
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Work summary</span>
              <textarea
                id="after-sales-service-record-summary"
                v-model="serviceRecordDraft.workSummary"
                class="after-sales-view__field-input after-sales-view__field-textarea"
                placeholder="What happened during this visit?"
              />
            </label>
          </form>

          <datalist id="after-sales-service-record-ticket-options">
            <option v-for="ticket in tickets" :key="ticket.id" :value="ticket.data.ticketNo" />
          </datalist>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__primary-btn"
              :disabled="serviceRecordCreating || serviceRecordsLoading || Boolean(serviceRecordUpdatingId) || !canSubmitServiceRecord"
              @click="submitServiceRecord"
            >
              {{ serviceRecordCreating ? 'Creating...' : 'Create service record' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="serviceRecordCreating || Boolean(serviceRecordUpdatingId)"
              @click="resetServiceRecordDraft"
            >
              Reset service record draft
            </button>
          </div>

          <p v-if="serviceRecordSubmitError" class="after-sales-view__inline-error">{{ serviceRecordSubmitError }}</p>
          <p v-else-if="serviceRecordSubmitSuccess" class="after-sales-view__inline-success">{{ serviceRecordSubmitSuccess }}</p>

          <form class="after-sales-view__service-record-filters" @submit.prevent="applyServiceRecordFilters">
            <label class="after-sales-view__field">
              <span>Filter ticket</span>
              <input
                id="after-sales-service-record-filter-ticket-no"
                v-model="serviceRecordFilters.ticketNo"
                class="after-sales-view__field-input"
                placeholder="AF-001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Filter result</span>
              <select
                id="after-sales-service-record-filter-result"
                v-model="serviceRecordFilters.result"
                class="after-sales-view__field-input"
              >
                <option value="">All results</option>
                <option value="resolved">Resolved</option>
                <option value="partial">Partial</option>
                <option value="escalated">Escalated</option>
              </select>
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Search summary</span>
              <input
                id="after-sales-service-record-filter-search"
                v-model="serviceRecordFilters.search"
                class="after-sales-view__field-input"
                placeholder="capacitor, onsite, Alex..."
                type="text"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__ghost-btn"
              :disabled="serviceRecordsLoading || serviceRecordCreating || Boolean(serviceRecordDeletingId) || Boolean(serviceRecordUpdatingId) || Boolean(serviceRecordEditingId)"
              @click="refreshServiceRecords"
            >
              {{ serviceRecordsLoading ? 'Refreshing...' : 'Refresh list' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="serviceRecordsLoading || serviceRecordCreating || Boolean(serviceRecordUpdatingId) || Boolean(serviceRecordEditingId)"
              @click="applyServiceRecordFilters"
            >
              {{ serviceRecordsLoading ? 'Applying...' : 'Apply filters' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="serviceRecordsLoading || serviceRecordCreating || Boolean(serviceRecordUpdatingId) || Boolean(serviceRecordEditingId)"
              @click="resetServiceRecordFilters"
            >
              Clear filters
            </button>
          </div>

          <p v-if="serviceRecordsLoading" class="after-sales-view__muted-state">Loading recent service records...</p>
          <p v-else-if="serviceRecordsError" class="after-sales-view__inline-error">{{ serviceRecordsError }}</p>
          <div v-else-if="serviceRecords.length" class="after-sales-view__service-record-list">
            <article v-for="record in serviceRecords" :key="record.id" class="after-sales-view__service-record-row">
              <div class="after-sales-view__service-record-main">
                <template v-if="serviceRecordEditingId === record.id">
                  <div class="after-sales-view__service-record-headline">
                    <strong>{{ record.data.ticketNo }}</strong>
                    <span class="after-sales-view__tag">{{ serviceRecordEditDraft.visitType }}</span>
                    <span v-if="serviceRecordEditDraft.result" class="after-sales-view__tag after-sales-view__tag--subtle">
                      {{ serviceRecordEditDraft.result }}
                    </span>
                  </div>
                  <form class="after-sales-view__service-record-form after-sales-view__ticket-form--inline" @submit.prevent="submitServiceRecordEdit(record)">
                    <label class="after-sales-view__field">
                      <span>Visit type</span>
                      <select
                        :id="`after-sales-service-record-edit-visit-type-${record.id}`"
                        v-model="serviceRecordEditDraft.visitType"
                        class="after-sales-view__field-input"
                      >
                        <option value="onsite">Onsite</option>
                        <option value="remote">Remote</option>
                        <option value="pickup">Pickup</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field">
                      <span>Scheduled at</span>
                      <input
                        :id="`after-sales-service-record-edit-scheduled-at-${record.id}`"
                        v-model="serviceRecordEditDraft.scheduledAt"
                        class="after-sales-view__field-input"
                        type="datetime-local"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Completed at</span>
                      <input
                        :id="`after-sales-service-record-edit-completed-at-${record.id}`"
                        v-model="serviceRecordEditDraft.completedAt"
                        class="after-sales-view__field-input"
                        type="datetime-local"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Technician</span>
                      <input
                        :id="`after-sales-service-record-edit-technician-${record.id}`"
                        v-model="serviceRecordEditDraft.technicianName"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Result</span>
                      <select
                        :id="`after-sales-service-record-edit-result-${record.id}`"
                        v-model="serviceRecordEditDraft.result"
                        class="after-sales-view__field-input"
                      >
                        <option value="">Pending</option>
                        <option value="resolved">Resolved</option>
                        <option value="partial">Partial</option>
                        <option value="escalated">Escalated</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field after-sales-view__field--wide">
                      <span>Work summary</span>
                      <textarea
                        :id="`after-sales-service-record-edit-summary-${record.id}`"
                        v-model="serviceRecordEditDraft.workSummary"
                        class="after-sales-view__field-input after-sales-view__field-textarea"
                      />
                    </label>
                  </form>
                </template>
                <template v-else>
                  <div class="after-sales-view__service-record-headline">
                    <strong>{{ record.data.ticketNo }}</strong>
                    <span class="after-sales-view__tag">{{ record.data.visitType }}</span>
                    <span v-if="record.data.result" class="after-sales-view__tag after-sales-view__tag--subtle">
                      {{ record.data.result }}
                    </span>
                  </div>
                  <p>{{ record.data.workSummary || 'No work summary yet.' }}</p>
                </template>
              </div>

              <div class="after-sales-view__service-record-side">
                <dl class="after-sales-view__service-record-meta">
                  <div>
                    <dt>Scheduled</dt>
                    <dd>{{ formatRecordDate(record.data.scheduledAt) }}</dd>
                  </div>
                  <div>
                    <dt>Completed</dt>
                    <dd>{{ formatRecordDate(record.data.completedAt) }}</dd>
                  </div>
                  <div>
                    <dt>Technician</dt>
                    <dd>{{ record.data.technicianName || 'Unassigned' }}</dd>
                  </div>
                </dl>
                <div v-if="serviceRecordEditingId === record.id" class="after-sales-view__ticket-actions">
                  <button
                    class="after-sales-view__primary-btn after-sales-view__ticket-action-btn"
                    :disabled="serviceRecordUpdatingId === record.id || serviceRecordsLoading || !canSubmitServiceRecordEdit"
                    @click="submitServiceRecordEdit(record)"
                  >
                    {{ serviceRecordUpdatingId === record.id ? 'Saving...' : 'Save changes' }}
                  </button>
                  <button
                    class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                    :disabled="serviceRecordUpdatingId === record.id"
                    @click="cancelServiceRecordEdit"
                  >
                    Cancel edit
                  </button>
                </div>
                <button
                  v-if="serviceRecordEditingId !== record.id"
                  class="after-sales-view__ghost-btn after-sales-view__service-record-delete"
                  :aria-label="`Edit service record ${record.data.ticketNo}`"
                  :disabled="Boolean(serviceRecordDeletingId) || Boolean(serviceRecordUpdatingId) || Boolean(serviceRecordEditingId)"
                  @click="startServiceRecordEdit(record)"
                >
                  Edit
                </button>
                <button
                  class="after-sales-view__ghost-btn after-sales-view__service-record-delete"
                  :aria-label="`Delete service record ${record.data.ticketNo}`"
                  :disabled="serviceRecordDeletingId === record.id || Boolean(serviceRecordUpdatingId) || serviceRecordEditingId === record.id"
                  @click="deleteServiceRecord(record)"
                >
                  {{ serviceRecordDeletingId === record.id ? 'Deleting...' : 'Delete' }}
                </button>
              </div>
            </article>
          </div>
          <p v-else class="after-sales-view__muted-state">No service records found yet.</p>
        </article>
      </section>

      <section v-if="isInstalled && hasCustomerProjection" class="after-sales-view__customers-shell">
        <article class="after-sales-view__card after-sales-view__card--wide">
          <div class="after-sales-view__section-header">
            <div>
              <p class="after-sales-view__pill">Customers</p>
              <h2>Customer registry</h2>
              <p>
                这里展示售后项目里的客户主数据，便于在工单、装机资产和服务记录之间核对客户状态。
              </p>
            </div>
          </div>

          <form class="after-sales-view__customer-form" @submit.prevent="submitCustomer">
            <label class="after-sales-view__field">
              <span>Customer code</span>
              <input
                id="after-sales-customer-code"
                v-model="customerDraft.customerCode"
                class="after-sales-view__field-input"
                placeholder="CUS-3001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Status</span>
              <select
                id="after-sales-customer-status"
                v-model="customerDraft.status"
                class="after-sales-view__field-input"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label class="after-sales-view__field">
              <span>Name</span>
              <input
                id="after-sales-customer-name"
                v-model="customerDraft.name"
                class="after-sales-view__field-input"
                placeholder="Alice Plant"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Phone</span>
              <input
                id="after-sales-customer-phone"
                v-model="customerDraft.phone"
                class="after-sales-view__field-input"
                placeholder="13800138000"
                type="text"
              />
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Email</span>
              <input
                id="after-sales-customer-email"
                v-model="customerDraft.email"
                class="after-sales-view__field-input"
                placeholder="alice@example.com"
                type="email"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__primary-btn"
              :disabled="customerCreating || customersLoading || Boolean(customerDeletingId) || Boolean(customerUpdatingId) || Boolean(customerEditingId) || !canSubmitCustomer"
              @click="submitCustomer"
            >
              {{ customerCreating ? 'Creating...' : 'Create customer' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="customerCreating || customersLoading || Boolean(customerDeletingId) || Boolean(customerUpdatingId) || Boolean(customerEditingId)"
              @click="resetCustomerDraft"
            >
              Reset customer draft
            </button>
          </div>

          <p v-if="customerSubmitError" class="after-sales-view__inline-error">{{ customerSubmitError }}</p>
          <p v-else-if="customerSubmitSuccess" class="after-sales-view__inline-success">{{ customerSubmitSuccess }}</p>

          <form class="after-sales-view__customer-filters" @submit.prevent="applyCustomerFilters">
            <label class="after-sales-view__field">
              <span>Filter status</span>
              <select
                id="after-sales-customer-filter-status"
                v-model="customerFilters.status"
                class="after-sales-view__field-input"
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Search customer</span>
              <input
                id="after-sales-customer-filter-search"
                v-model="customerFilters.search"
                class="after-sales-view__field-input"
                placeholder="customer code, name, phone, email..."
                type="text"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__ghost-btn"
              :disabled="customersLoading || customerCreating || Boolean(customerDeletingId) || Boolean(customerUpdatingId) || Boolean(customerEditingId)"
              @click="refreshCustomers"
            >
              {{ customersLoading ? 'Refreshing...' : 'Refresh list' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="customersLoading || customerCreating || Boolean(customerDeletingId) || Boolean(customerUpdatingId) || Boolean(customerEditingId)"
              @click="applyCustomerFilters"
            >
              {{ customersLoading ? 'Applying...' : 'Apply filters' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="customersLoading || customerCreating || Boolean(customerDeletingId) || Boolean(customerUpdatingId) || Boolean(customerEditingId)"
              @click="resetCustomerFilters"
            >
              Clear filters
            </button>
          </div>

          <p v-if="customersLoading" class="after-sales-view__muted-state">Loading customers...</p>
          <p v-else-if="customersError" class="after-sales-view__inline-error">{{ customersError }}</p>
          <div v-else-if="customers.length" class="after-sales-view__customer-list">
            <article v-for="customer in customers" :key="customer.id" class="after-sales-view__customer-row">
              <div class="after-sales-view__customer-main">
                <template v-if="customerEditingId === customer.id">
                  <div class="after-sales-view__customer-headline">
                    <strong>{{ customerEditDraft.name || customer.data.name }}</strong>
                    <span class="after-sales-view__tag">{{ customerEditDraft.status }}</span>
                    <span class="after-sales-view__tag after-sales-view__tag--subtle">
                      {{ customerEditDraft.customerCode || customer.data.customerCode }}
                    </span>
                  </div>
                  <form class="after-sales-view__customer-form after-sales-view__ticket-form--inline" @submit.prevent="submitCustomerEdit(customer)">
                    <label class="after-sales-view__field">
                      <span>Customer code</span>
                      <input
                        :id="`after-sales-customer-edit-code-${customer.id}`"
                        v-model="customerEditDraft.customerCode"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Status</span>
                      <select
                        :id="`after-sales-customer-edit-status-${customer.id}`"
                        v-model="customerEditDraft.status"
                        class="after-sales-view__field-input"
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field">
                      <span>Name</span>
                      <input
                        :id="`after-sales-customer-edit-name-${customer.id}`"
                        v-model="customerEditDraft.name"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Phone</span>
                      <input
                        :id="`after-sales-customer-edit-phone-${customer.id}`"
                        v-model="customerEditDraft.phone"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field after-sales-view__field--wide">
                      <span>Email</span>
                      <input
                        :id="`after-sales-customer-edit-email-${customer.id}`"
                        v-model="customerEditDraft.email"
                        class="after-sales-view__field-input"
                        type="email"
                      />
                    </label>
                  </form>
                </template>
                <template v-else>
                  <div class="after-sales-view__customer-headline">
                    <strong>{{ customer.data.name }}</strong>
                    <span class="after-sales-view__tag">{{ customer.data.status }}</span>
                    <span class="after-sales-view__tag after-sales-view__tag--subtle">{{ customer.data.customerCode }}</span>
                  </div>
                  <p>{{ customer.data.email || customer.data.phone || 'No contact details yet.' }}</p>
                </template>
              </div>

              <div class="after-sales-view__customer-side">
                <dl class="after-sales-view__customer-meta">
                  <div>
                    <dt>Phone</dt>
                    <dd>{{ customer.data.phone || '—' }}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd>{{ customer.data.email || '—' }}</dd>
                  </div>
                </dl>
                <div v-if="customerEditingId === customer.id" class="after-sales-view__ticket-actions">
                  <button
                    class="after-sales-view__primary-btn after-sales-view__ticket-action-btn"
                    :disabled="customerUpdatingId === customer.id || customersLoading || !canSubmitCustomerEdit"
                    @click="submitCustomerEdit(customer)"
                  >
                    {{ customerUpdatingId === customer.id ? 'Saving...' : 'Save changes' }}
                  </button>
                  <button
                    class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                    :disabled="customerUpdatingId === customer.id"
                    @click="cancelCustomerEdit"
                  >
                    Cancel edit
                  </button>
                </div>
                <button
                  v-if="customerEditingId !== customer.id"
                  class="after-sales-view__ghost-btn after-sales-view__customer-delete"
                  :aria-label="`Edit customer ${customer.data.customerCode}`"
                  :disabled="Boolean(customerDeletingId) || Boolean(customerUpdatingId) || Boolean(customerEditingId)"
                  @click="startCustomerEdit(customer)"
                >
                  Edit
                </button>
                <button
                  class="after-sales-view__ghost-btn after-sales-view__customer-delete"
                  :aria-label="`Delete customer ${customer.data.customerCode}`"
                  :disabled="Boolean(customerDeletingId) || customerCreating || customersLoading || Boolean(customerUpdatingId) || Boolean(customerEditingId)"
                  @click="deleteCustomer(customer)"
                >
                  {{ customerDeletingId === customer.id ? 'Deleting...' : 'Delete' }}
                </button>
              </div>
            </article>
          </div>
          <p v-else class="after-sales-view__muted-state">No customers found yet.</p>
        </article>
      </section>

      <section v-if="isInstalled && hasFollowUpProjection" class="after-sales-view__follow-ups-shell">
        <article class="after-sales-view__card after-sales-view__card--wide">
          <div class="after-sales-view__section-header">
            <div>
              <p class="after-sales-view__pill">Follow-ups</p>
              <h2>Follow-up queue</h2>
              <p>
                这里展示待回访队列，便于按 ticket、状态和摘要快速检索后续联系事项。
              </p>
            </div>
          </div>

          <form class="after-sales-view__follow-up-form" @submit.prevent="submitFollowUp">
            <label class="after-sales-view__field">
              <span>Ticket no</span>
              <input
                id="after-sales-follow-up-ticket-no"
                v-model="followUpDraft.ticketNo"
                class="after-sales-view__field-input"
                placeholder="TK-3001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Customer name</span>
              <input
                id="after-sales-follow-up-customer-name"
                v-model="followUpDraft.customerName"
                class="after-sales-view__field-input"
                placeholder="Alice Plant"
                type="text"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Due at</span>
              <input
                id="after-sales-follow-up-due-at"
                v-model="followUpDraft.dueAt"
                class="after-sales-view__field-input"
                type="datetime-local"
              />
            </label>
            <label class="after-sales-view__field">
              <span>Follow-up type</span>
              <select
                id="after-sales-follow-up-type"
                v-model="followUpDraft.followUpType"
                class="after-sales-view__field-input"
              >
                <option value="phone">Phone</option>
                <option value="message">Message</option>
                <option value="onsite">Onsite</option>
              </select>
            </label>
            <label class="after-sales-view__field">
              <span>Owner</span>
              <input
                id="after-sales-follow-up-owner-name"
                v-model="followUpDraft.ownerName"
                class="after-sales-view__field-input"
                placeholder="CSR Chen"
                type="text"
              />
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Summary</span>
              <textarea
                id="after-sales-follow-up-summary"
                v-model="followUpDraft.summary"
                class="after-sales-view__field-input after-sales-view__field-textarea"
                placeholder="What needs to happen during the follow-up?"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__primary-btn"
              :disabled="followUpCreating || followUpsLoading || Boolean(followUpDeletingId) || !canSubmitFollowUp"
              @click="submitFollowUp"
            >
              {{ followUpCreating ? 'Creating...' : 'Create follow-up' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="followUpCreating || followUpsLoading || Boolean(followUpDeletingId)"
              @click="resetFollowUpDraft"
            >
              Reset follow-up draft
            </button>
          </div>

          <p v-if="followUpSubmitError" class="after-sales-view__inline-error">{{ followUpSubmitError }}</p>
          <p v-else-if="followUpSubmitSuccess" class="after-sales-view__inline-success">{{ followUpSubmitSuccess }}</p>

          <form class="after-sales-view__follow-up-filters" @submit.prevent="applyFollowUpFilters">
            <label class="after-sales-view__field">
              <span>Filter status</span>
              <select
                id="after-sales-follow-up-filter-status"
                v-model="followUpFilters.status"
                class="after-sales-view__field-input"
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="done">Done</option>
                <option value="skipped">Skipped</option>
              </select>
            </label>
            <label class="after-sales-view__field">
              <span>Filter ticket</span>
              <input
                id="after-sales-follow-up-filter-ticket-no"
                v-model="followUpFilters.ticketNo"
                class="after-sales-view__field-input"
                placeholder="TK-3001"
                type="text"
              />
            </label>
            <label class="after-sales-view__field after-sales-view__field--wide">
              <span>Search follow-up</span>
              <input
                id="after-sales-follow-up-filter-search"
                v-model="followUpFilters.search"
                class="after-sales-view__field-input"
                placeholder="customer, owner, summary..."
                type="text"
              />
            </label>
          </form>

          <div class="after-sales-view__action-row after-sales-view__action-row--compact">
            <button
              class="after-sales-view__ghost-btn"
              :disabled="followUpsLoading || followUpCreating || Boolean(followUpDeletingId)"
              @click="refreshFollowUps"
            >
              {{ followUpsLoading ? 'Refreshing...' : 'Refresh list' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="followUpsLoading || followUpCreating || Boolean(followUpDeletingId)"
              @click="applyFollowUpFilters"
            >
              {{ followUpsLoading ? 'Applying...' : 'Apply filters' }}
            </button>
            <button
              class="after-sales-view__ghost-btn"
              :disabled="followUpsLoading || followUpCreating || Boolean(followUpDeletingId)"
              @click="resetFollowUpFilters"
            >
              Clear filters
            </button>
          </div>

          <p v-if="followUpsLoading" class="after-sales-view__muted-state">Loading follow-ups...</p>
          <p v-else-if="followUpsError" class="after-sales-view__inline-error">{{ followUpsError }}</p>
          <div v-else-if="followUps.length" class="after-sales-view__follow-up-list">
            <article v-for="followUp in followUps" :key="followUp.id" class="after-sales-view__follow-up-row">
              <div class="after-sales-view__follow-up-main">
                <template v-if="followUpEditingId === followUp.id">
                  <div class="after-sales-view__follow-up-headline">
                    <strong>{{ followUp.data.ticketNo }}</strong>
                    <span class="after-sales-view__tag">{{ followUpEditDraft.status }}</span>
                    <span class="after-sales-view__tag after-sales-view__tag--subtle">{{ followUpEditDraft.followUpType }}</span>
                  </div>
                  <form class="after-sales-view__follow-up-form after-sales-view__ticket-form--inline" @submit.prevent="submitFollowUpEdit(followUp)">
                    <label class="after-sales-view__field">
                      <span>Ticket no</span>
                      <input
                        :id="`after-sales-follow-up-edit-ticket-no-${followUp.id}`"
                        :value="followUp.data.ticketNo"
                        class="after-sales-view__field-input"
                        readonly
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Customer name</span>
                      <input
                        :id="`after-sales-follow-up-edit-customer-name-${followUp.id}`"
                        v-model="followUpEditDraft.customerName"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Due at</span>
                      <input
                        :id="`after-sales-follow-up-edit-due-at-${followUp.id}`"
                        v-model="followUpEditDraft.dueAt"
                        class="after-sales-view__field-input"
                        type="datetime-local"
                      />
                    </label>
                    <label class="after-sales-view__field">
                      <span>Follow-up type</span>
                      <select
                        :id="`after-sales-follow-up-edit-type-${followUp.id}`"
                        v-model="followUpEditDraft.followUpType"
                        class="after-sales-view__field-input"
                      >
                        <option value="phone">Phone</option>
                        <option value="message">Message</option>
                        <option value="onsite">Onsite</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field">
                      <span>Status</span>
                      <select
                        :id="`after-sales-follow-up-edit-status-${followUp.id}`"
                        v-model="followUpEditDraft.status"
                        class="after-sales-view__field-input"
                      >
                        <option value="pending">Pending</option>
                        <option value="done">Done</option>
                        <option value="skipped">Skipped</option>
                      </select>
                    </label>
                    <label class="after-sales-view__field">
                      <span>Owner</span>
                      <input
                        :id="`after-sales-follow-up-edit-owner-name-${followUp.id}`"
                        v-model="followUpEditDraft.ownerName"
                        class="after-sales-view__field-input"
                        type="text"
                      />
                    </label>
                    <label class="after-sales-view__field after-sales-view__field--wide">
                      <span>Summary</span>
                      <textarea
                        :id="`after-sales-follow-up-edit-summary-${followUp.id}`"
                        v-model="followUpEditDraft.summary"
                        class="after-sales-view__field-input after-sales-view__field-textarea"
                      />
                    </label>
                  </form>
                </template>
                <template v-else>
                  <div class="after-sales-view__follow-up-headline">
                    <strong>{{ followUp.data.ticketNo }}</strong>
                    <span class="after-sales-view__tag">{{ followUp.data.status }}</span>
                    <span class="after-sales-view__tag after-sales-view__tag--subtle">{{ followUp.data.followUpType }}</span>
                  </div>
                  <p>{{ followUp.data.summary || 'No follow-up summary yet.' }}</p>
                </template>
              </div>

              <div class="after-sales-view__follow-up-side">
                <dl class="after-sales-view__follow-up-meta">
                  <div>
                    <dt>Due at</dt>
                    <dd>{{ formatRecordDate(followUp.data.dueAt) }}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{{ followUp.data.ownerName || 'Unassigned' }}</dd>
                  </div>
                  <div>
                    <dt>Customer</dt>
                    <dd>{{ followUp.data.customerName || 'Unknown customer' }}</dd>
                  </div>
                </dl>
                <div v-if="followUpEditingId === followUp.id" class="after-sales-view__ticket-actions">
                  <button
                    class="after-sales-view__primary-btn after-sales-view__ticket-action-btn"
                    :disabled="followUpUpdatingId === followUp.id || followUpsLoading || !canSubmitFollowUpEdit"
                    @click="submitFollowUpEdit(followUp)"
                  >
                    {{ followUpUpdatingId === followUp.id ? 'Saving...' : 'Save changes' }}
                  </button>
                  <button
                    class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                    :disabled="followUpUpdatingId === followUp.id"
                    @click="cancelFollowUpEdit"
                  >
                    Cancel edit
                  </button>
                </div>
                <button
                  v-if="followUpEditingId !== followUp.id"
                  class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                  :aria-label="`Edit follow-up ${followUp.data.ticketNo}`"
                  :disabled="Boolean(followUpDeletingId) || Boolean(followUpUpdatingId) || Boolean(followUpEditingId) || followUpCreating || followUpsLoading"
                  @click="startFollowUpEdit(followUp)"
                >
                  Edit
                </button>
                <button
                  class="after-sales-view__ghost-btn after-sales-view__ticket-action-btn"
                  :aria-label="`Delete follow-up ${followUp.data.ticketNo}`"
                  :disabled="Boolean(followUpDeletingId) || followUpCreating || followUpsLoading || Boolean(followUpUpdatingId) || Boolean(followUpEditingId)"
                  @click="deleteFollowUp(followUp)"
                >
                  {{ followUpDeletingId === followUp.id ? 'Deleting...' : 'Delete' }}
                </button>
              </div>
            </article>
          </div>
          <p v-else class="after-sales-view__muted-state">No follow-ups found yet.</p>
        </article>
      </section>

      <section class="after-sales-view__grid">
        <article class="after-sales-view__card">
          <h2>Install state</h2>
          <dl class="after-sales-view__meta">
            <div>
              <dt>Status</dt>
              <dd>{{ current.status }}</dd>
            </div>
            <div>
              <dt>Project ID</dt>
              <dd><code>{{ current.projectId || placeholderProjectId }}</code></dd>
            </div>
            <div>
              <dt>Display name</dt>
              <dd>{{ current.displayName || manifest?.displayName || 'After Sales' }}</dd>
            </div>
            <div>
              <dt>Report ref</dt>
              <dd><code>{{ current.reportRef || current.installResult?.reportRef || 'n/a' }}</code></dd>
            </div>
          </dl>
        </article>

        <article class="after-sales-view__card">
          <h2>Manifest objects</h2>
          <ul v-if="manifest?.objects?.length" class="after-sales-view__list">
            <li v-for="item in manifest.objects" :key="item.id">
              <strong>{{ item.name }}</strong> <span>({{ item.backing }})</span>
            </li>
          </ul>
          <p v-else>No objects declared yet.</p>
        </article>

        <article class="after-sales-view__card">
          <h2>Workflows</h2>
          <ul v-if="manifest?.workflows?.length" class="after-sales-view__list">
            <li v-for="item in manifest.workflows" :key="item.id">{{ item.name }}</li>
          </ul>
          <p v-else>No workflows declared yet.</p>
        </article>

        <article class="after-sales-view__card">
          <h2>Created in this install</h2>
          <ul v-if="createdObjectLabels.length || createdViewLabels.length" class="after-sales-view__list">
            <li v-for="item in createdObjectLabels" :key="`obj-${item}`">Object: {{ item }}</li>
            <li v-for="item in createdViewLabels" :key="`view-${item}`">View: {{ item }}</li>
          </ul>
          <p v-else>No install payload available yet.</p>
        </article>
      </section>
    </section>

    <div v-if="showWarnings" class="after-sales-view__modal-backdrop" @click.self="showWarnings = false">
      <div class="after-sales-view__modal">
        <header class="after-sales-view__modal-header">
          <div>
            <p class="after-sales-view__pill">Install warnings</p>
            <h2>Installer diagnostics</h2>
          </div>
          <button class="after-sales-view__close-btn" @click="showWarnings = false">×</button>
        </header>
        <ul v-if="warnings.length" class="after-sales-view__list">
          <li v-for="item in warnings" :key="item">{{ item }}</li>
        </ul>
        <p v-else>No warnings captured for the current install.</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

interface AfterSalesManifest {
  id: string
  displayName: string
  platformDependencies: string[]
  objects: Array<{ id: string; name: string; backing: string }>
  workflows: Array<{ id: string; name: string }>
}

interface InstallResult {
  status: 'installed' | 'partial' | 'failed'
  createdObjects: string[]
  createdViews: string[]
  warnings: string[]
  reportRef?: string
}

interface CurrentResponse {
  status: 'not-installed' | 'installed' | 'partial' | 'failed'
  projectId?: string
  displayName?: string
  config?: Record<string, unknown>
  installResult?: InstallResult
  reportRef?: string
}

interface TicketRecord {
  id: string
  version: number
  data: Record<string, unknown>
}

interface TicketsResponse {
  projectId: string
  tickets: TicketRecord[]
  count: number
}

interface ApprovalSnapshot {
  id: string
  status: string
  currentStep?: number
  totalSteps?: number
  updatedAt?: string
}

interface TicketViewModel {
  id: string
  version: number
  data: {
    ticketNo: string
    title: string
    priority: string
    source: string
    status: string
    refundStatus: string
    refundAmount: number | null
  }
  approvalLabel: string
}

interface ServiceRecordRow {
  id: string
  version: number
  data: Record<string, unknown>
}

interface ServiceRecordsResponse {
  projectId: string
  serviceRecords: ServiceRecordRow[]
  count: number
}

interface ServiceRecordViewModel {
  id: string
  version: number
  data: {
    ticketNo: string
    visitType: string
    scheduledAt: string
    completedAt: string
    technicianName: string
    workSummary: string
    result: string
  }
}

interface InstalledAssetRow {
  id: string
  version: number
  data: Record<string, unknown>
}

interface CustomerRow {
  id: string
  version: number
  data: Record<string, unknown>
}

interface InstalledAssetsResponse {
  projectId: string
  installedAssets: InstalledAssetRow[]
  count: number
}

interface CustomersResponse {
  projectId: string
  customers: CustomerRow[]
  count: number
}

interface FollowUpRow {
  id: string
  version: number
  data: Record<string, unknown>
}

interface FollowUpsResponse {
  projectId: string
  followUps: FollowUpRow[]
  count: number
}

interface InstalledAssetViewModel {
  id: string
  version: number
  data: {
    assetCode: string
    serialNo: string
    model: string
    location: string
    installedAt: string
    warrantyUntil: string
    status: string
  }
}

interface CustomerViewModel {
  id: string
  version: number
  data: {
    customerCode: string
    name: string
    phone: string
    email: string
    status: string
  }
}

interface FollowUpViewModel {
  id: string
  version: number
  data: {
    ticketNo: string
    customerName: string
    dueAt: string
    followUpType: string
    ownerName: string
    status: string
    summary: string
  }
}

interface FollowUpDraft {
  ticketNo: string
  customerName: string
  dueAt: string
  followUpType: 'phone' | 'message' | 'onsite'
  ownerName: string
  summary: string
}

interface FollowUpEditDraft {
  customerName: string
  dueAt: string
  followUpType: 'phone' | 'message' | 'onsite'
  ownerName: string
  status: 'pending' | 'done' | 'skipped'
  summary: string
}

interface CustomerDraft {
  customerCode: string
  name: string
  phone: string
  email: string
  status: 'active' | 'inactive'
}

interface CustomerEditDraft {
  customerCode: string
  name: string
  phone: string
  email: string
  status: 'active' | 'inactive'
}

interface InstalledAssetDraft {
  assetCode: string
  serialNo: string
  model: string
  location: string
  installedAt: string
  warrantyUntil: string
  status: 'active' | 'expired' | 'decommissioned'
}

interface InstalledAssetEditDraft {
  assetCode: string
  serialNo: string
  model: string
  location: string
  installedAt: string
  warrantyUntil: string
  status: 'active' | 'expired' | 'decommissioned'
}

interface ServiceRecordDraft {
  ticketNo: string
  visitType: 'onsite' | 'remote' | 'pickup'
  scheduledAt: string
  completedAt: string
  technicianName: string
  workSummary: string
  result: '' | 'resolved' | 'partial' | 'escalated'
}

interface ServiceRecordEditDraft {
  visitType: 'onsite' | 'remote' | 'pickup'
  scheduledAt: string
  completedAt: string
  technicianName: string
  workSummary: string
  result: '' | 'resolved' | 'partial' | 'escalated'
}

interface TicketDraft {
  ticketNo: string
  title: string
  priority: 'normal' | 'high' | 'urgent'
  source: 'web' | 'phone' | 'wechat'
  refundAmount: string
}

interface TicketEditDraft {
  title: string
  priority: 'normal' | 'high' | 'urgent'
  source: 'web' | 'phone' | 'wechat' | 'email'
  status: 'new' | 'assigned' | 'inProgress' | 'done' | 'closed'
}

interface ServiceRecordFilterDraft {
  ticketNo: string
  result: '' | 'resolved' | 'partial' | 'escalated'
  search: string
}

interface InstalledAssetFilterDraft {
  status: '' | 'active' | 'expired' | 'decommissioned'
  search: string
}

interface CustomerFilterDraft {
  status: '' | 'active' | 'inactive'
  search: string
}

interface FollowUpFilterDraft {
  status: '' | 'pending' | 'done' | 'skipped'
  ticketNo: string
  search: string
}

interface TicketFilterDraft {
  status: string
  search: string
}

interface CreateServiceRecordResponse {
  projectId: string
  serviceRecord: ServiceRecordRow
}

interface CreateInstalledAssetResponse {
  projectId: string
  installedAsset: InstalledAssetRow
}

interface CreateCustomerResponse {
  projectId: string
  customer: CustomerRow
}

interface CreateFollowUpResponse {
  projectId: string
  followUp: FollowUpRow
}

interface CreateTicketResponse {
  projectId: string
  ticket: TicketRecord
}

interface ApiEnvelope<T> {
  ok: boolean
  data: T
  error?: {
    code?: string
    message?: string
  }
}

type FieldVisibility = 'hidden' | 'visible'
type FieldEditability = 'readonly' | 'editable'

interface TicketFieldPolicy {
  visibility: FieldVisibility
  editability: FieldEditability
}

interface TicketFieldPolicyResponse {
  projectId: string
  fields: {
    serviceTicket: {
      refundAmount: TicketFieldPolicy
    }
  }
}

const TEMPLATE_ID = 'after-sales-default'
const DEFAULT_CONFIG = {
  enableWarranty: true,
  enableRefundApproval: true,
  enableVisitScheduling: true,
  enableFollowUp: true,
  defaultSlaHours: 24,
  urgentSlaHours: 4,
  followUpAfterDays: 7,
  overdueWebhook: '',
}

const DEFAULT_TICKET_FIELD_POLICY: TicketFieldPolicy = {
  visibility: 'visible',
  editability: 'editable',
}

const loading = ref(true)
const installing = ref(false)
const refreshing = ref(false)
const ticketsLoading = ref(false)
const ticketCreating = ref(false)
const ticketRefundSubmittingId = ref('')
const ticketUpdatingId = ref('')
const ticketDeletingId = ref('')
const installedAssetsLoading = ref(false)
const customersLoading = ref(false)
const followUpsLoading = ref(false)
const installedAssetCreating = ref(false)
const customerCreating = ref(false)
const followUpCreating = ref(false)
const followUpDeletingId = ref('')
const followUpUpdatingId = ref('')
const customerDeletingId = ref('')
const customerUpdatingId = ref('')
const installedAssetUpdatingId = ref('')
const installedAssetDeletingId = ref('')
const serviceRecordsLoading = ref(false)
const serviceRecordCreating = ref(false)
const serviceRecordUpdatingId = ref('')
const serviceRecordDeletingId = ref('')
const error = ref('')
const ticketsError = ref('')
const installedAssetsError = ref('')
const customersError = ref('')
const followUpsError = ref('')
const customerSubmitError = ref('')
const customerSubmitSuccess = ref('')
const followUpSubmitError = ref('')
const followUpSubmitSuccess = ref('')
const installedAssetSubmitError = ref('')
const installedAssetSubmitSuccess = ref('')
const ticketSubmitError = ref('')
const ticketSubmitSuccess = ref('')
const ticketRefundErrorById = ref<Record<string, string>>({})
const serviceRecordsError = ref('')
const serviceRecordSubmitError = ref('')
const serviceRecordSubmitSuccess = ref('')
const showWarnings = ref(false)
const manifest = ref<AfterSalesManifest | null>(null)
const current = ref<CurrentResponse>({ status: 'not-installed' })
const tickets = ref<TicketViewModel[]>([])
const installedAssets = ref<InstalledAssetViewModel[]>([])
const customers = ref<CustomerViewModel[]>([])
const followUps = ref<FollowUpViewModel[]>([])
const serviceRecords = ref<ServiceRecordViewModel[]>([])
const configDraft = ref({ ...DEFAULT_CONFIG })
const baselineConfigDraft = ref({ ...DEFAULT_CONFIG })
const ticketFieldPolicies = ref<TicketFieldPolicyResponse | null>(null)
const ticketDraft = ref<TicketDraft>(createTicketDraft())
const ticketEditingId = ref('')
const ticketEditDraft = ref<TicketEditDraft>(createTicketEditDraft())
const ticketRefundDrafts = ref<Record<string, string>>({})
const ticketFilters = ref<TicketFilterDraft>({
  status: '',
  search: '',
})
const installedAssetFilters = ref<InstalledAssetFilterDraft>({
  status: '',
  search: '',
})
const customerDraft = ref<CustomerDraft>(createCustomerDraft())
const followUpDraft = ref<FollowUpDraft>(createFollowUpDraft())
const followUpEditingId = ref('')
const followUpEditDraft = ref<FollowUpEditDraft>(createFollowUpEditDraft())
const customerEditingId = ref('')
const customerEditDraft = ref<CustomerEditDraft>(createCustomerEditDraft())
const customerFilters = ref<CustomerFilterDraft>({
  status: '',
  search: '',
})
const followUpFilters = ref<FollowUpFilterDraft>({
  status: '',
  ticketNo: '',
  search: '',
})
const installedAssetDraft = ref<InstalledAssetDraft>(createInstalledAssetDraft())
const installedAssetEditingId = ref('')
const installedAssetEditDraft = ref<InstalledAssetEditDraft>(createInstalledAssetEditDraft())
const serviceRecordDraft = ref<ServiceRecordDraft>(createServiceRecordDraft())
const serviceRecordEditingId = ref('')
const serviceRecordEditDraft = ref<ServiceRecordEditDraft>(createServiceRecordEditDraft())
const serviceRecordFilters = ref<ServiceRecordFilterDraft>({
  ticketNo: '',
  result: '',
  search: '',
})

const placeholderProjectId = 'tenant:after-sales'
const warnings = computed(() => current.value.installResult?.warnings ?? [])
const createdObjectLabels = computed(() => current.value.installResult?.createdObjects ?? [])
const createdViewLabels = computed(() => current.value.installResult?.createdViews ?? [])
const isInstalled = computed(() => current.value.status === 'installed' || current.value.status === 'partial')
const isDegraded = computed(() => current.value.status === 'partial' || current.value.status === 'failed')
const refundAmountPolicy = computed<TicketFieldPolicy>(
  () => ticketFieldPolicies.value?.fields?.serviceTicket?.refundAmount ?? DEFAULT_TICKET_FIELD_POLICY,
)
const isRefundAmountHidden = computed(() => refundAmountPolicy.value.visibility === 'hidden')
const isRefundAmountEditable = computed(
  () => refundAmountPolicy.value.visibility === 'visible' && refundAmountPolicy.value.editability === 'editable',
)
const hasCustomerProjection = computed(() =>
  Array.isArray(manifest.value?.objects) &&
  manifest.value.objects.some((object) => object && object.id === 'customer'),
)
const hasFollowUpProjection = computed(() =>
  Array.isArray(manifest.value?.objects) &&
  manifest.value.objects.some((object) => object && object.id === 'followUp'),
)
const canSubmitCustomer = computed(
  () =>
    toText(customerDraft.value.customerCode).length > 0 &&
    toText(customerDraft.value.name).length > 0,
)
const canSubmitFollowUp = computed(
  () =>
    toText(followUpDraft.value.ticketNo).length > 0 &&
    toText(followUpDraft.value.customerName).length > 0 &&
    toText(followUpDraft.value.dueAt).length > 0,
)
const canSubmitFollowUpEdit = computed(
  () =>
    Boolean(followUpEditingId.value) &&
    toText(followUpEditDraft.value.customerName).length > 0 &&
    toText(followUpEditDraft.value.dueAt).length > 0,
)
const canSubmitCustomerEdit = computed(
  () =>
    toText(customerEditDraft.value.customerCode).length > 0 &&
    toText(customerEditDraft.value.name).length > 0,
)
const canSubmitServiceRecord = computed(
  () =>
    toText(serviceRecordDraft.value.ticketNo).length > 0 &&
    toText(serviceRecordDraft.value.scheduledAt).length > 0,
)
const canSubmitInstalledAsset = computed(() => toText(installedAssetDraft.value.assetCode).length > 0)
const canSubmitInstalledAssetEdit = computed(
  () =>
    Boolean(installedAssetEditingId.value) &&
    toText(installedAssetEditDraft.value.assetCode).length > 0,
)
const canSubmitServiceRecordEdit = computed(
  () =>
    Boolean(serviceRecordEditingId.value) &&
    toText(serviceRecordEditDraft.value.scheduledAt).length > 0,
)
const ticketDraftError = computed(() => {
  if (!isRefundAmountEditable.value) {
    return ''
  }
  const parsedRefundAmount = parseOptionalRefundAmount(ticketDraft.value.refundAmount)
  return parsedRefundAmount.valid ? '' : 'Refund amount must be a valid number'
})
const canSubmitTicket = computed(
  () =>
    toText(ticketDraft.value.ticketNo).length > 0 &&
    toText(ticketDraft.value.title).length > 0 &&
    ticketDraftError.value.length === 0,
)
const canSubmitTicketEdit = computed(() => {
  if (!ticketEditingId.value) return false
  return toText(ticketEditDraft.value.title).length > 0
})
const statusTone = computed(() => {
  switch (current.value.status) {
    case 'installed':
      return 'success'
    case 'partial':
      return 'warning'
    case 'failed':
      return 'danger'
    default:
      return 'neutral'
  }
})
const statusLabel = computed(() => {
  switch (current.value.status) {
    case 'installed':
      return 'Installed'
    case 'partial':
      return 'Partial'
    case 'failed':
      return 'Failed'
    default:
      return 'Not installed'
  }
})

function extractMessage(payload: unknown, fallback: string): string {
  const errorMessage =
    payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: { message?: string } }).error?.message
      : ''
  return typeof errorMessage === 'string' && errorMessage.trim().length > 0 ? errorMessage : fallback
}

async function readEnvelope<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await apiFetch(path, options)
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(extractMessage(payload, `${response.status} ${response.statusText}`))
  }
  return ((payload as ApiEnvelope<T> | null)?.data ?? null) as T
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const next = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(next) && next > 0 ? next : fallback
}

function toText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value.trim()
  }
  return fallback
}

function toRefundAmount(value: unknown): number | null {
  const next = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(next) ? next : null
}

function formatRefundAmount(value: unknown): string {
  const amount = toRefundAmount(value)
  if (amount == null) return '—'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

function formatRefundDraft(value: unknown): string {
  const amount = toRefundAmount(value)
  if (amount == null) return ''
  return `${amount}`
}

function formatRecordDate(value: unknown): string {
  const text = toText(value)
  if (!text) {
    return '—'
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) {
    return text
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(parsed)
}

function normalizeConfigDraft(config?: Record<string, unknown> | null) {
  return {
    ...DEFAULT_CONFIG,
    enableWarranty: typeof config?.enableWarranty === 'boolean' ? config.enableWarranty : DEFAULT_CONFIG.enableWarranty,
    enableRefundApproval: typeof config?.enableRefundApproval === 'boolean' ? config.enableRefundApproval : DEFAULT_CONFIG.enableRefundApproval,
    enableVisitScheduling: typeof config?.enableVisitScheduling === 'boolean' ? config.enableVisitScheduling : DEFAULT_CONFIG.enableVisitScheduling,
    enableFollowUp: typeof config?.enableFollowUp === 'boolean' ? config.enableFollowUp : DEFAULT_CONFIG.enableFollowUp,
    defaultSlaHours: toPositiveNumber(config?.defaultSlaHours, DEFAULT_CONFIG.defaultSlaHours),
    urgentSlaHours: toPositiveNumber(config?.urgentSlaHours, DEFAULT_CONFIG.urgentSlaHours),
    followUpAfterDays: toPositiveNumber(config?.followUpAfterDays ?? config?.followUpDays, DEFAULT_CONFIG.followUpAfterDays),
    overdueWebhook: toText(config?.overdueWebhook, DEFAULT_CONFIG.overdueWebhook),
  }
}

function createServiceRecordDraft(): ServiceRecordDraft {
  return {
    ticketNo: '',
    visitType: 'onsite',
    scheduledAt: '',
    completedAt: '',
    technicianName: '',
    workSummary: '',
    result: '',
  }
}

function createInstalledAssetDraft(): InstalledAssetDraft {
  return {
    assetCode: '',
    serialNo: '',
    model: '',
    location: '',
    installedAt: '',
    warrantyUntil: '',
    status: 'active',
  }
}

function createCustomerDraft(): CustomerDraft {
  return {
    customerCode: '',
    name: '',
    phone: '',
    email: '',
    status: 'active',
  }
}

function createFollowUpDraft(): FollowUpDraft {
  return {
    ticketNo: '',
    customerName: '',
    dueAt: '',
    followUpType: 'phone',
    ownerName: '',
    summary: '',
  }
}

function normalizeFollowUpType(value: unknown): FollowUpEditDraft['followUpType'] {
  return value === 'message' || value === 'onsite' ? value : 'phone'
}

function normalizeFollowUpStatus(value: unknown): FollowUpEditDraft['status'] {
  return value === 'done' || value === 'skipped' ? value : 'pending'
}

function createFollowUpEditDraft(
  followUp?: Partial<FollowUpViewModel['data']> | null,
): FollowUpEditDraft {
  return {
    customerName: toText(followUp?.customerName),
    dueAt: toText(followUp?.dueAt),
    followUpType: normalizeFollowUpType(followUp?.followUpType),
    ownerName: toText(followUp?.ownerName),
    status: normalizeFollowUpStatus(followUp?.status),
    summary: toText(followUp?.summary),
  }
}

function createCustomerEditDraft(customer?: Partial<CustomerViewModel['data']> | null): CustomerEditDraft {
  return {
    customerCode: toText(customer?.customerCode),
    name: toText(customer?.name),
    phone: toText(customer?.phone),
    email: toText(customer?.email),
    status: normalizeCustomerStatus(customer?.status),
  }
}

function normalizeCustomerStatus(value: unknown): CustomerEditDraft['status'] {
  return value === 'inactive' ? 'inactive' : 'active'
}

function createInstalledAssetEditDraft(
  asset?: Partial<InstalledAssetViewModel['data']> | null,
): InstalledAssetEditDraft {
  return {
    assetCode: toText(asset?.assetCode),
    serialNo: toText(asset?.serialNo),
    model: toText(asset?.model),
    location: toText(asset?.location),
    installedAt: toText(asset?.installedAt),
    warrantyUntil: toText(asset?.warrantyUntil),
    status:
      asset?.status === 'expired' || asset?.status === 'decommissioned'
        ? asset.status
        : 'active',
  }
}

function createServiceRecordEditDraft(
  record?: Partial<ServiceRecordViewModel['data']> | null,
): ServiceRecordEditDraft {
  return {
    visitType:
      record?.visitType === 'remote' || record?.visitType === 'pickup'
        ? record.visitType
        : 'onsite',
    scheduledAt: toText(record?.scheduledAt),
    completedAt: toText(record?.completedAt),
    technicianName: toText(record?.technicianName),
    workSummary: toText(record?.workSummary),
    result:
      record?.result === 'resolved' || record?.result === 'partial' || record?.result === 'escalated'
        ? record.result
        : '',
  }
}

function createTicketDraft(): TicketDraft {
  return {
    ticketNo: '',
    title: '',
    priority: 'normal',
    source: 'web',
    refundAmount: '',
  }
}

function normalizeTicketPriority(value: unknown): TicketEditDraft['priority'] {
  return value === 'high' || value === 'urgent' ? value : 'normal'
}

function normalizeTicketSource(value: unknown): TicketEditDraft['source'] {
  return value === 'phone' || value === 'wechat' || value === 'email' ? value : 'web'
}

function normalizeTicketStatus(value: unknown): TicketEditDraft['status'] {
  if (value === 'assigned' || value === 'inProgress' || value === 'done' || value === 'closed') {
    return value
  }
  if (value === 'open') {
    return 'new'
  }
  return 'new'
}

function createTicketEditDraft(ticket?: Partial<TicketViewModel['data']> | null): TicketEditDraft {
  return {
    title: toText(ticket?.title),
    priority: normalizeTicketPriority(ticket?.priority),
    source: normalizeTicketSource(ticket?.source),
    status: normalizeTicketStatus(ticket?.status),
  }
}

function resetConfigDraft() {
  configDraft.value = { ...baselineConfigDraft.value }
}

function resetInstalledAssetDraft() {
  installedAssetDraft.value = createInstalledAssetDraft()
  installedAssetSubmitError.value = ''
  installedAssetSubmitSuccess.value = ''
}

function resetCustomerDraft() {
  customerDraft.value = createCustomerDraft()
  customerSubmitError.value = ''
  customerSubmitSuccess.value = ''
}

function resetFollowUpDraft() {
  followUpDraft.value = createFollowUpDraft()
  followUpSubmitError.value = ''
  followUpSubmitSuccess.value = ''
}

function cancelFollowUpEdit() {
  followUpEditingId.value = ''
  followUpEditDraft.value = createFollowUpEditDraft()
  followUpSubmitError.value = ''
}

function cancelCustomerEdit() {
  customerEditingId.value = ''
  customerEditDraft.value = createCustomerEditDraft()
  customerSubmitError.value = ''
}

function cancelInstalledAssetEdit() {
  installedAssetEditingId.value = ''
  installedAssetEditDraft.value = createInstalledAssetEditDraft()
  installedAssetSubmitError.value = ''
}

function resetServiceRecordDraft() {
  serviceRecordDraft.value = createServiceRecordDraft()
  serviceRecordSubmitError.value = ''
  serviceRecordSubmitSuccess.value = ''
}

function cancelServiceRecordEdit() {
  serviceRecordEditingId.value = ''
  serviceRecordEditDraft.value = createServiceRecordEditDraft()
  serviceRecordSubmitError.value = ''
}

function resetTicketDraft() {
  ticketDraft.value = createTicketDraft()
  ticketSubmitError.value = ''
  ticketSubmitSuccess.value = ''
}

function cancelTicketEdit() {
  ticketEditingId.value = ''
  ticketEditDraft.value = createTicketEditDraft()
  ticketSubmitError.value = ''
}

function buildInstallConfig() {
  return {
    enableWarranty: configDraft.value.enableWarranty,
    enableRefundApproval: configDraft.value.enableRefundApproval,
    enableVisitScheduling: configDraft.value.enableVisitScheduling,
    enableFollowUp: configDraft.value.enableFollowUp,
    defaultSlaHours: toPositiveNumber(configDraft.value.defaultSlaHours, DEFAULT_CONFIG.defaultSlaHours),
    urgentSlaHours: toPositiveNumber(configDraft.value.urgentSlaHours, DEFAULT_CONFIG.urgentSlaHours),
    followUpAfterDays: toPositiveNumber(configDraft.value.followUpAfterDays, DEFAULT_CONFIG.followUpAfterDays),
    ...(toText(configDraft.value.overdueWebhook) ? { overdueWebhook: toText(configDraft.value.overdueWebhook) } : {}),
  }
}

function buildServiceRecordPayload() {
  const ticketNo = toText(serviceRecordDraft.value.ticketNo)
  const scheduledAt = toText(serviceRecordDraft.value.scheduledAt)
  const completedAt = toText(serviceRecordDraft.value.completedAt)
  const technicianName = toText(serviceRecordDraft.value.technicianName)
  const workSummary = toText(serviceRecordDraft.value.workSummary)
  const result = toText(serviceRecordDraft.value.result)

  return {
    serviceRecord: {
      ticketNo,
      visitType: serviceRecordDraft.value.visitType,
      scheduledAt,
      ...(completedAt ? { completedAt } : {}),
      ...(technicianName ? { technicianName } : {}),
      ...(workSummary ? { workSummary } : {}),
      ...(result ? { result } : {}),
    },
  }
}

function buildInstalledAssetPayload() {
  const assetCode = toText(installedAssetDraft.value.assetCode)
  const serialNo = toText(installedAssetDraft.value.serialNo)
  const model = toText(installedAssetDraft.value.model)
  const location = toText(installedAssetDraft.value.location)
  const installedAt = toText(installedAssetDraft.value.installedAt)
  const warrantyUntil = toText(installedAssetDraft.value.warrantyUntil)

  return {
    installedAsset: {
      assetCode,
      status: installedAssetDraft.value.status,
      ...(serialNo ? { serialNo } : {}),
      ...(model ? { model } : {}),
      ...(location ? { location } : {}),
      ...(installedAt ? { installedAt } : {}),
      ...(warrantyUntil ? { warrantyUntil } : {}),
    },
  }
}

function buildCustomerPayload() {
  const customerCode = toText(customerDraft.value.customerCode)
  const name = toText(customerDraft.value.name)
  const phone = toText(customerDraft.value.phone)
  const email = toText(customerDraft.value.email)

  return {
    customer: {
      customerCode,
      name,
      status: customerDraft.value.status,
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
    },
  }
}

function buildFollowUpPayload() {
  const ticketNo = toText(followUpDraft.value.ticketNo)
  const customerName = toText(followUpDraft.value.customerName)
  const dueAt = toText(followUpDraft.value.dueAt)
  const ownerName = toText(followUpDraft.value.ownerName)
  const summary = toText(followUpDraft.value.summary)

  return {
    followUp: {
      ticketNo,
      customerName,
      dueAt,
      followUpType: followUpDraft.value.followUpType,
      ...(ownerName ? { ownerName } : {}),
      ...(summary ? { summary } : {}),
    },
  }
}

function buildFollowUpUpdatePayload(followUp: FollowUpViewModel) {
  const changes: Record<string, string> = {}
  const customerName = toText(followUpEditDraft.value.customerName)
  const dueAt = toText(followUpEditDraft.value.dueAt)
  const ownerName = toText(followUpEditDraft.value.ownerName)
  const summary = toText(followUpEditDraft.value.summary)
  const followUpType = followUpEditDraft.value.followUpType
  const status = followUpEditDraft.value.status

  if (customerName !== toText(followUp.data.customerName)) {
    changes.customerName = customerName
  }
  if (dueAt !== toText(followUp.data.dueAt)) {
    changes.dueAt = dueAt
  }
  if (followUpType !== normalizeFollowUpType(followUp.data.followUpType)) {
    changes.followUpType = followUpType
  }
  if (ownerName !== toText(followUp.data.ownerName)) {
    changes.ownerName = ownerName
  }
  if (status !== normalizeFollowUpStatus(followUp.data.status)) {
    changes.status = status
  }
  if (summary !== toText(followUp.data.summary)) {
    changes.summary = summary
  }

  if (!Object.keys(changes).length) {
    return null
  }

  return {
    followUp: changes,
  }
}

function buildCustomerUpdatePayload(customer: CustomerViewModel) {
  const changes: Record<string, string> = {}
  const customerCode = toText(customerEditDraft.value.customerCode)
  const name = toText(customerEditDraft.value.name)
  const phone = toText(customerEditDraft.value.phone)
  const email = toText(customerEditDraft.value.email)
  const status = customerEditDraft.value.status

  if (customerCode !== toText(customer.data.customerCode)) {
    changes.customerCode = customerCode
  }
  if (name !== toText(customer.data.name)) {
    changes.name = name
  }
  if (status !== normalizeCustomerStatus(customer.data.status)) {
    changes.status = status
  }
  if (phone !== toText(customer.data.phone)) {
    changes.phone = phone
  }
  if (email !== toText(customer.data.email)) {
    changes.email = email
  }

  if (!Object.keys(changes).length) {
    return null
  }

  return {
    customer: changes,
  }
}

function buildInstalledAssetUpdatePayload() {
  return {
    installedAsset: {
      assetCode: toText(installedAssetEditDraft.value.assetCode),
      status: installedAssetEditDraft.value.status,
      serialNo: toText(installedAssetEditDraft.value.serialNo),
      model: toText(installedAssetEditDraft.value.model),
      location: toText(installedAssetEditDraft.value.location),
      installedAt: toText(installedAssetEditDraft.value.installedAt),
      warrantyUntil: toText(installedAssetEditDraft.value.warrantyUntil),
    },
  }
}

function buildServiceRecordUpdatePayload() {
  const scheduledAt = toText(serviceRecordEditDraft.value.scheduledAt)
  const completedAt = toText(serviceRecordEditDraft.value.completedAt)
  const technicianName = toText(serviceRecordEditDraft.value.technicianName)
  const workSummary = toText(serviceRecordEditDraft.value.workSummary)
  const result = toText(serviceRecordEditDraft.value.result)

  return {
    serviceRecord: {
      visitType: serviceRecordEditDraft.value.visitType,
      scheduledAt,
      completedAt,
      technicianName,
      workSummary,
      result,
    },
  }
}

function parseOptionalRefundAmount(value: unknown): { valid: boolean; value?: number } {
  const text = toText(value)
  if (!text) {
    return { valid: true }
  }

  const amount = Number(text)
  if (!Number.isFinite(amount)) {
    return { valid: false }
  }

  return {
    valid: true,
    value: amount,
  }
}

function buildTicketPayload() {
  const ticketNo = toText(ticketDraft.value.ticketNo)
  const title = toText(ticketDraft.value.title)
  const refundAmount = parseOptionalRefundAmount(ticketDraft.value.refundAmount)

  return {
    ticket: {
      ticketNo,
      title,
      priority: ticketDraft.value.priority,
      source: ticketDraft.value.source,
      ...(
        isRefundAmountEditable.value && refundAmount.valid && typeof refundAmount.value === 'number'
          ? { refundAmount: refundAmount.value }
          : {}
      ),
    },
  }
}

function matchesInstalledAssetFilters(asset: InstalledAssetViewModel) {
  const status = toText(installedAssetFilters.value.status)
  const search = toText(installedAssetFilters.value.search).toLowerCase()

  if (status && asset.data.status !== status) return false
  if (search) {
    const haystack = JSON.stringify(asset.data).toLowerCase()
    if (!haystack.includes(search)) return false
  }

  return true
}

function buildTicketUpdatePayload() {
  return {
    ticket: {
      title: toText(ticketEditDraft.value.title),
      priority: ticketEditDraft.value.priority,
      source: ticketEditDraft.value.source,
      status: ticketEditDraft.value.status,
    },
  }
}

function buildServiceRecordListPath() {
  const params = new URLSearchParams()
  const ticketNo = toText(serviceRecordFilters.value.ticketNo)
  const result = toText(serviceRecordFilters.value.result)
  const search = toText(serviceRecordFilters.value.search)
  if (ticketNo) params.set('ticketNo', ticketNo)
  if (result) params.set('result', result)
  if (search) params.set('search', search)
  const query = params.toString()
  return query ? `/api/after-sales/service-records?${query}` : '/api/after-sales/service-records'
}

function buildInstalledAssetListPath() {
  const params = new URLSearchParams()
  const status = toText(installedAssetFilters.value.status)
  const search = toText(installedAssetFilters.value.search)
  if (status) params.set('status', status)
  if (search) params.set('search', search)
  const query = params.toString()
  return query ? `/api/after-sales/installed-assets?${query}` : '/api/after-sales/installed-assets'
}

function buildCustomerListPath() {
  const params = new URLSearchParams()
  const status = toText(customerFilters.value.status)
  const search = toText(customerFilters.value.search)
  if (status) params.set('status', status)
  if (search) params.set('search', search)
  const query = params.toString()
  return query ? `/api/after-sales/customers?${query}` : '/api/after-sales/customers'
}

function buildFollowUpListPath() {
  const params = new URLSearchParams()
  const status = toText(followUpFilters.value.status)
  const ticketNo = toText(followUpFilters.value.ticketNo)
  const search = toText(followUpFilters.value.search)
  if (status) params.set('status', status)
  if (ticketNo) params.set('ticketNo', ticketNo)
  if (search) params.set('search', search)
  const query = params.toString()
  return query ? `/api/after-sales/follow-ups?${query}` : '/api/after-sales/follow-ups'
}

function buildTicketListPath() {
  const params = new URLSearchParams()
  const status = toText(ticketFilters.value.status)
  const search = toText(ticketFilters.value.search)
  if (status) params.set('status', status)
  if (search) params.set('search', search)
  const query = params.toString()
  return query ? `/api/after-sales/tickets?${query}` : '/api/after-sales/tickets'
}

function matchesServiceRecordFilters(record: ServiceRecordViewModel) {
  const ticketNo = toText(serviceRecordFilters.value.ticketNo)
  const result = toText(serviceRecordFilters.value.result)
  const search = toText(serviceRecordFilters.value.search).toLowerCase()

  if (ticketNo && record.data.ticketNo !== ticketNo) return false
  if (result && record.data.result !== result) return false
  if (search) {
    const haystack = JSON.stringify(record.data).toLowerCase()
    if (!haystack.includes(search)) return false
  }

  return true
}

function formatApprovalLabel(ticket: TicketViewModel['data'], approval: ApprovalSnapshot | null): string {
  if (ticket.refundStatus !== 'pending') {
    return ticket.refundStatus || 'not requested'
  }
  if (!approval) {
    return 'Approval unavailable'
  }
  const stepInfo =
    typeof approval.currentStep === 'number' && typeof approval.totalSteps === 'number' && approval.totalSteps > 0
      ? ` step ${approval.currentStep}/${approval.totalSteps}`
      : ''
  return `${approval.status}${stepInfo}`
}

function matchesTicketFilters(ticket: TicketViewModel) {
  const status = toText(ticketFilters.value.status)
  const search = toText(ticketFilters.value.search).toLowerCase()

  if (status && ticket.data.status !== status) return false
  if (search) {
    const haystack = JSON.stringify(ticket.data).toLowerCase()
    if (!haystack.includes(search)) return false
  }

  return true
}

function normalizeTicket(ticket: TicketRecord, approval: ApprovalSnapshot | null): TicketViewModel {
  const rawData = ticket.data && typeof ticket.data === 'object' ? ticket.data : {}
  const normalized: TicketViewModel['data'] = {
    ticketNo: toText(rawData.ticketNo, ticket.id),
    title: toText(rawData.title, 'Untitled ticket'),
    priority: toText(rawData.priority, 'normal'),
    source: toText(rawData.source, 'web'),
    status: toText(rawData.status, 'new'),
    refundStatus: toText(rawData.refundStatus),
    refundAmount: toRefundAmount(rawData.refundAmount),
  }

  return {
    id: ticket.id,
    version: ticket.version,
    data: normalized,
    approvalLabel: formatApprovalLabel(normalized, approval),
  }
}

function updateTicketRefundDraft(ticketId: string, event: Event) {
  const value = event.target instanceof HTMLInputElement ? event.target.value : ''
  ticketRefundDrafts.value = {
    ...ticketRefundDrafts.value,
    [ticketId]: value,
  }

  if (ticketRefundErrorById.value[ticketId]) {
    ticketRefundErrorById.value = {
      ...ticketRefundErrorById.value,
      [ticketId]: '',
    }
  }
}

function startTicketEdit(ticket: TicketViewModel) {
  if (!ticket.id || ticketUpdatingId.value || ticketDeletingId.value || ticketCreating.value || ticketsLoading.value) {
    return
  }
  ticketEditingId.value = ticket.id
  ticketEditDraft.value = createTicketEditDraft(ticket.data)
  ticketSubmitError.value = ''
  ticketSubmitSuccess.value = ''
}

function normalizeServiceRecordRow(record: ServiceRecordRow): ServiceRecordViewModel {
  const rawData = record.data && typeof record.data === 'object' ? record.data : {}
  return {
    id: record.id,
    version: record.version,
    data: {
      ticketNo: toText(rawData.ticketNo, record.id),
      visitType: toText(rawData.visitType, 'unspecified'),
      scheduledAt: toText(rawData.scheduledAt, 'n/a'),
      completedAt: toText(rawData.completedAt),
      technicianName: toText(rawData.technicianName),
      workSummary: toText(rawData.workSummary),
      result: toText(rawData.result),
    },
  }
}

function normalizeInstalledAssetRow(record: InstalledAssetRow): InstalledAssetViewModel {
  const rawData = record.data && typeof record.data === 'object' ? record.data : {}
  return {
    id: record.id,
    version: record.version,
    data: {
      assetCode: toText(rawData.assetCode, record.id),
      serialNo: toText(rawData.serialNo),
      model: toText(rawData.model),
      location: toText(rawData.location),
      installedAt: toText(rawData.installedAt),
      warrantyUntil: toText(rawData.warrantyUntil),
      status: toText(rawData.status, 'unknown'),
    },
  }
}

function normalizeCustomerRow(record: CustomerRow): CustomerViewModel {
  const rawData = record.data && typeof record.data === 'object' ? record.data : {}
  return {
    id: record.id,
    version: record.version,
    data: {
      customerCode: toText(rawData.customerCode, record.id),
      name: toText(rawData.name, 'Unnamed customer'),
      phone: toText(rawData.phone),
      email: toText(rawData.email),
      status: toText(rawData.status, 'unknown'),
    },
  }
}

function normalizeFollowUpRow(record: FollowUpRow): FollowUpViewModel {
  const rawData = record.data && typeof record.data === 'object' ? record.data : {}
  return {
    id: record.id,
    version: record.version,
    data: {
      ticketNo: toText(rawData.ticketNo, record.id),
      customerName: toText(rawData.customerName),
      dueAt: toText(rawData.dueAt),
      followUpType: toText(rawData.followUpType, 'manual'),
      ownerName: toText(rawData.ownerName),
      status: toText(rawData.status, 'pending'),
      summary: toText(rawData.summary),
    },
  }
}

function matchesCustomerFilters(customer: CustomerViewModel) {
  const status = toText(customerFilters.value.status)
  const search = toText(customerFilters.value.search).toLowerCase()

  if (status && customer.data.status !== status) return false
  if (search) {
    const haystack = JSON.stringify(customer.data).toLowerCase()
    if (!haystack.includes(search)) return false
  }

  return true
}

function matchesFollowUpFilters(followUp: FollowUpViewModel) {
  const status = toText(followUpFilters.value.status)
  const ticketNo = toText(followUpFilters.value.ticketNo)
  const search = toText(followUpFilters.value.search).toLowerCase()

  if (status && followUp.data.status !== status) return false
  if (ticketNo && followUp.data.ticketNo !== ticketNo) return false
  if (search) {
    const haystack = JSON.stringify(followUp.data).toLowerCase()
    if (!haystack.includes(search)) return false
  }

  return true
}

function startCustomerEdit(customer: CustomerViewModel) {
  if (!customer.id || customerUpdatingId.value || customerDeletingId.value || customerCreating.value || customersLoading.value) {
    return
  }
  customerEditingId.value = customer.id
  customerEditDraft.value = createCustomerEditDraft(customer.data)
  customerSubmitError.value = ''
  customerSubmitSuccess.value = ''
}

function startFollowUpEdit(followUp: FollowUpViewModel) {
  if (
    !followUp.id ||
    followUpUpdatingId.value ||
    followUpDeletingId.value ||
    followUpCreating.value ||
    followUpsLoading.value
  ) {
    return
  }
  followUpEditingId.value = followUp.id
  followUpEditDraft.value = createFollowUpEditDraft(followUp.data)
  followUpSubmitError.value = ''
  followUpSubmitSuccess.value = ''
}

function startInstalledAssetEdit(asset: InstalledAssetViewModel) {
  if (!asset.id || installedAssetUpdatingId.value || installedAssetDeletingId.value || installedAssetCreating.value || installedAssetsLoading.value) {
    return
  }
  installedAssetEditingId.value = asset.id
  installedAssetEditDraft.value = createInstalledAssetEditDraft(asset.data)
  installedAssetSubmitError.value = ''
  installedAssetSubmitSuccess.value = ''
}

function startServiceRecordEdit(record: ServiceRecordViewModel) {
  if (!record.id || serviceRecordUpdatingId.value || serviceRecordDeletingId.value || serviceRecordCreating.value || serviceRecordsLoading.value) {
    return
  }
  serviceRecordEditingId.value = record.id
  serviceRecordEditDraft.value = createServiceRecordEditDraft(record.data)
  serviceRecordSubmitError.value = ''
  serviceRecordSubmitSuccess.value = ''
}

async function loadManifest() {
  manifest.value = await readEnvelope<AfterSalesManifest>('/api/after-sales/app-manifest')
}

async function loadRefundApproval(projectId: string, ticketId: string): Promise<ApprovalSnapshot | null> {
  try {
    const payload = await readEnvelope<{ approval: ApprovalSnapshot | null }>(
      `/api/after-sales/tickets/${encodeURIComponent(ticketId)}/refund-approval`,
    )
    return payload?.approval ?? null
  } catch {
    return null
  }
}

async function loadTicketsForCurrentState(state: CurrentResponse): Promise<void> {
  ticketsLoading.value = true
  ticketsError.value = ''
  try {
    if (state.status === 'not-installed' || state.status === 'failed') {
      tickets.value = []
      return
    }

    const payload = await readEnvelope<TicketsResponse>(buildTicketListPath())
    const rows = Array.isArray(payload?.tickets) ? payload.tickets : []
    tickets.value = await Promise.all(
      rows.map(async (ticket) => {
        const approval =
          toText(ticket?.data?.refundStatus) === 'pending'
            ? await loadRefundApproval(state.projectId || placeholderProjectId, ticket.id)
            : null
        return normalizeTicket(ticket, approval)
      }),
    )
  } catch (err: unknown) {
    tickets.value = []
    if (state.status === 'installed' || state.status === 'partial') {
      ticketsError.value = err instanceof Error ? err.message : 'Failed to load after-sales tickets'
    }
  } finally {
    ticketsLoading.value = false
  }
}

async function applyTicketFilters() {
  if (ticketUpdatingId.value || ticketEditingId.value) {
    return
  }
  await loadTicketsForCurrentState(current.value)
}

async function resetTicketFilters() {
  if (ticketUpdatingId.value || ticketEditingId.value) {
    return
  }
  ticketFilters.value = {
    status: '',
    search: '',
  }
  await loadTicketsForCurrentState(current.value)
}

async function refreshTickets() {
  if (ticketCreating.value || ticketDeletingId.value || ticketUpdatingId.value || ticketEditingId.value) {
    return
  }
  await loadTicketsForCurrentState(current.value)
}

async function loadInstalledAssetsForCurrentState(state: CurrentResponse): Promise<void> {
  installedAssetsLoading.value = true
  installedAssetsError.value = ''
  try {
    if (state.status === 'not-installed' || state.status === 'failed') {
      installedAssets.value = []
      return
    }

    const payload = await readEnvelope<InstalledAssetsResponse>(buildInstalledAssetListPath())
    const rows = Array.isArray(payload?.installedAssets) ? payload.installedAssets : []
    installedAssets.value = rows.map((row) => normalizeInstalledAssetRow(row))
  } catch (err: unknown) {
    installedAssets.value = []
    if (state.status === 'installed' || state.status === 'partial') {
      installedAssetsError.value = err instanceof Error ? err.message : 'Failed to load installed assets'
    }
  } finally {
    installedAssetsLoading.value = false
  }
}

async function loadCustomersForCurrentState(state: CurrentResponse): Promise<void> {
  customersLoading.value = true
  customersError.value = ''
  try {
    if (!hasCustomerProjection.value) {
      customers.value = []
      return
    }
    if (state.status === 'not-installed' || state.status === 'failed') {
      customers.value = []
      return
    }

    const payload = await readEnvelope<CustomersResponse>(buildCustomerListPath())
    const rows = Array.isArray(payload?.customers) ? payload.customers : []
    customers.value = rows.map((row) => normalizeCustomerRow(row))
  } catch (err: unknown) {
    customers.value = []
    if (state.status === 'installed' || state.status === 'partial') {
      customersError.value = err instanceof Error ? err.message : 'Failed to load after-sales customers'
    }
  } finally {
    customersLoading.value = false
  }
}

async function applyCustomerFilters() {
  if (customersLoading.value || customerCreating.value || customerDeletingId.value || customerUpdatingId.value || customerEditingId.value) {
    return
  }
  await loadCustomersForCurrentState(current.value)
}

async function resetCustomerFilters() {
  if (customersLoading.value || customerCreating.value || customerDeletingId.value || customerUpdatingId.value || customerEditingId.value) {
    return
  }
  customerFilters.value = {
    status: '',
    search: '',
  }
  await loadCustomersForCurrentState(current.value)
}

async function refreshCustomers() {
  if (customersLoading.value || customerCreating.value || customerDeletingId.value || customerUpdatingId.value || customerEditingId.value) {
    return
  }
  await loadCustomersForCurrentState(current.value)
}

async function loadFollowUpsForCurrentState(state: CurrentResponse): Promise<void> {
  followUpsLoading.value = true
  followUpsError.value = ''
  try {
    if (!hasFollowUpProjection.value) {
      followUps.value = []
      return
    }
    if (state.status === 'not-installed' || state.status === 'failed') {
      followUps.value = []
      return
    }

    const payload = await readEnvelope<FollowUpsResponse>(buildFollowUpListPath())
    const rows = Array.isArray(payload?.followUps) ? payload.followUps : []
    followUps.value = rows.map((row) => normalizeFollowUpRow(row))
  } catch (err: unknown) {
    followUps.value = []
    if (state.status === 'installed' || state.status === 'partial') {
      followUpsError.value = err instanceof Error ? err.message : 'Failed to load follow-ups'
    }
  } finally {
    followUpsLoading.value = false
  }
}

async function applyFollowUpFilters() {
  if (
    followUpsLoading.value ||
    followUpCreating.value ||
    followUpDeletingId.value ||
    followUpUpdatingId.value ||
    followUpEditingId.value
  ) {
    return
  }
  await loadFollowUpsForCurrentState(current.value)
}

async function resetFollowUpFilters() {
  if (
    followUpsLoading.value ||
    followUpCreating.value ||
    followUpDeletingId.value ||
    followUpUpdatingId.value ||
    followUpEditingId.value
  ) {
    return
  }
  followUpFilters.value = {
    status: '',
    ticketNo: '',
    search: '',
  }
  await loadFollowUpsForCurrentState(current.value)
}

async function refreshFollowUps() {
  if (
    followUpsLoading.value ||
    followUpCreating.value ||
    followUpDeletingId.value ||
    followUpUpdatingId.value ||
    followUpEditingId.value
  ) {
    return
  }
  await loadFollowUpsForCurrentState(current.value)
}

async function submitFollowUp() {
  if (
    !canSubmitFollowUp.value ||
    followUpCreating.value ||
    followUpsLoading.value ||
    followUpDeletingId.value ||
    followUpUpdatingId.value ||
    followUpEditingId.value
  ) {
    return
  }

  followUpCreating.value = true
  followUpSubmitError.value = ''
  followUpSubmitSuccess.value = ''

  try {
    const payload = await readEnvelope<CreateFollowUpResponse>('/api/after-sales/follow-ups', {
      method: 'POST',
      body: JSON.stringify(buildFollowUpPayload()),
    })
    const nextFollowUp = payload?.followUp ? normalizeFollowUpRow(payload.followUp) : null

    if (nextFollowUp && matchesFollowUpFilters(nextFollowUp)) {
      followUps.value = [nextFollowUp, ...followUps.value.filter((item) => item.id !== nextFollowUp.id)]
      followUpsError.value = ''
    }

    resetFollowUpDraft()
    followUpSubmitSuccess.value = nextFollowUp
      ? `Created follow-up for ${nextFollowUp.data.ticketNo}`
      : 'Created follow-up'
  } catch (err: unknown) {
    followUpSubmitError.value = err instanceof Error ? err.message : 'Failed to create follow-up'
  } finally {
    followUpCreating.value = false
  }
}

async function submitFollowUpEdit(followUp: FollowUpViewModel) {
  if (
    !followUp.id ||
    followUpEditingId.value !== followUp.id ||
    followUpUpdatingId.value ||
    !canSubmitFollowUpEdit.value
  ) {
    return
  }

  followUpUpdatingId.value = followUp.id
  followUpSubmitError.value = ''
  followUpSubmitSuccess.value = ''

  try {
    const updatePayload = buildFollowUpUpdatePayload(followUp)
    if (!updatePayload) {
      followUpEditingId.value = ''
      followUpEditDraft.value = createFollowUpEditDraft()
      return
    }

    const payload = await readEnvelope<CreateFollowUpResponse>(
      `/api/after-sales/follow-ups/${encodeURIComponent(followUp.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updatePayload),
      },
    )
    const nextFollowUp = payload?.followUp ? normalizeFollowUpRow(payload.followUp) : null

    if (nextFollowUp) {
      followUps.value = matchesFollowUpFilters(nextFollowUp)
        ? followUps.value.map((item) => (item.id === nextFollowUp.id ? nextFollowUp : item))
        : followUps.value.filter((item) => item.id !== nextFollowUp.id)
      followUpsError.value = ''
      followUpSubmitSuccess.value = `Updated follow-up for ${nextFollowUp.data.ticketNo}`
    }

    followUpEditingId.value = ''
    followUpEditDraft.value = createFollowUpEditDraft()
  } catch (err: unknown) {
    followUpSubmitError.value = err instanceof Error ? err.message : 'Failed to update follow-up'
  } finally {
    followUpUpdatingId.value = ''
  }
}

async function deleteFollowUp(followUp: FollowUpViewModel) {
  if (
    !followUp.id ||
    followUpDeletingId.value ||
    followUpCreating.value ||
    followUpsLoading.value ||
    followUpUpdatingId.value ||
    followUpEditingId.value
  ) {
    return
  }

  followUpDeletingId.value = followUp.id
  followUpSubmitError.value = ''
  followUpSubmitSuccess.value = ''

  try {
    await readEnvelope(`/api/after-sales/follow-ups/${encodeURIComponent(followUp.id)}`, {
      method: 'DELETE',
    })
    followUps.value = followUps.value.filter((item) => item.id !== followUp.id)
    followUpsError.value = ''
    followUpSubmitSuccess.value = `Deleted follow-up for ${followUp.data.ticketNo}`
  } catch (err: unknown) {
    followUpSubmitError.value = err instanceof Error ? err.message : 'Failed to delete follow-up'
  } finally {
    followUpDeletingId.value = ''
  }
}

async function submitCustomer() {
  if (!canSubmitCustomer.value || customersLoading.value || customerCreating.value || customerDeletingId.value || customerUpdatingId.value || customerEditingId.value) {
    return
  }

  customerCreating.value = true
  customerSubmitError.value = ''
  customerSubmitSuccess.value = ''

  try {
    const payload = await readEnvelope<CreateCustomerResponse>('/api/after-sales/customers', {
      method: 'POST',
      body: JSON.stringify(buildCustomerPayload()),
    })
    const nextCustomer = payload?.customer ? normalizeCustomerRow(payload.customer) : null

    if (nextCustomer && matchesCustomerFilters(nextCustomer)) {
      customers.value = [nextCustomer, ...customers.value.filter((item) => item.id !== nextCustomer.id)]
      customersError.value = ''
    }

    resetCustomerDraft()
    customerSubmitSuccess.value = nextCustomer
      ? `Created customer ${nextCustomer.data.customerCode}`
      : 'Created customer'
  } catch (err: unknown) {
    customerSubmitError.value = err instanceof Error ? err.message : 'Failed to create customer'
  } finally {
    customerCreating.value = false
  }
}

async function submitCustomerEdit(customer: CustomerViewModel) {
  if (
    !customer.id ||
    customerEditingId.value !== customer.id ||
    customerUpdatingId.value ||
    !canSubmitCustomerEdit.value
  ) {
    return
  }

  customerUpdatingId.value = customer.id
  customerSubmitError.value = ''
  customerSubmitSuccess.value = ''

  try {
    const updatePayload = buildCustomerUpdatePayload(customer)
    if (!updatePayload) {
      customerEditingId.value = ''
      customerEditDraft.value = createCustomerEditDraft()
      return
    }

    const payload = await readEnvelope<CreateCustomerResponse>(
      `/api/after-sales/customers/${encodeURIComponent(customer.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updatePayload),
      },
    )
    const nextCustomer = payload?.customer ? normalizeCustomerRow(payload.customer) : null

    if (nextCustomer) {
      customers.value = matchesCustomerFilters(nextCustomer)
        ? customers.value.map((item) => (item.id === nextCustomer.id ? nextCustomer : item))
        : customers.value.filter((item) => item.id !== nextCustomer.id)
      customersError.value = ''
      customerSubmitSuccess.value = `Updated customer ${nextCustomer.data.customerCode}`
    }

    customerEditingId.value = ''
    customerEditDraft.value = createCustomerEditDraft()
  } catch (err: unknown) {
    customerSubmitError.value = err instanceof Error ? err.message : 'Failed to update customer'
  } finally {
    customerUpdatingId.value = ''
  }
}

async function deleteCustomer(customer: CustomerViewModel) {
  if (!customer.id || customerDeletingId.value || customerCreating.value || customersLoading.value || customerUpdatingId.value || customerEditingId.value) {
    return
  }

  customerDeletingId.value = customer.id
  customerSubmitError.value = ''
  customerSubmitSuccess.value = ''

  try {
    await readEnvelope(`/api/after-sales/customers/${encodeURIComponent(customer.id)}`, {
      method: 'DELETE',
    })
    customers.value = customers.value.filter((item) => item.id !== customer.id)
    customersError.value = ''
    customerSubmitSuccess.value = `Deleted customer ${customer.data.customerCode}`
  } catch (err: unknown) {
    customerSubmitError.value = err instanceof Error ? err.message : 'Failed to delete customer'
  } finally {
    customerDeletingId.value = ''
  }
}

async function applyInstalledAssetFilters() {
  if (installedAssetCreating.value || installedAssetDeletingId.value || installedAssetUpdatingId.value || installedAssetEditingId.value) {
    return
  }
  await loadInstalledAssetsForCurrentState(current.value)
}

async function resetInstalledAssetFilters() {
  if (installedAssetCreating.value || installedAssetDeletingId.value || installedAssetUpdatingId.value || installedAssetEditingId.value) {
    return
  }
  installedAssetFilters.value = {
    status: '',
    search: '',
  }
  await loadInstalledAssetsForCurrentState(current.value)
}

async function refreshInstalledAssets() {
  if (installedAssetCreating.value || installedAssetDeletingId.value || installedAssetUpdatingId.value || installedAssetEditingId.value) {
    return
  }
  await loadInstalledAssetsForCurrentState(current.value)
}

async function submitInstalledAsset() {
  if (
    !canSubmitInstalledAsset.value ||
    installedAssetCreating.value ||
    installedAssetsLoading.value ||
    Boolean(installedAssetDeletingId.value) ||
    Boolean(installedAssetUpdatingId.value) ||
    Boolean(installedAssetEditingId.value)
  ) {
    return
  }

  installedAssetCreating.value = true
  installedAssetSubmitError.value = ''
  installedAssetSubmitSuccess.value = ''

  try {
    const payload = await readEnvelope<CreateInstalledAssetResponse>('/api/after-sales/installed-assets', {
      method: 'POST',
      body: JSON.stringify(buildInstalledAssetPayload()),
    })
    const nextAsset = payload?.installedAsset ? normalizeInstalledAssetRow(payload.installedAsset) : null

    if (nextAsset && matchesInstalledAssetFilters(nextAsset)) {
      installedAssets.value = [nextAsset, ...installedAssets.value.filter((item) => item.id !== nextAsset.id)]
      installedAssetsError.value = ''
    }

    resetInstalledAssetDraft()
    installedAssetSubmitSuccess.value = nextAsset
      ? `Created installed asset ${nextAsset.data.assetCode}`
      : 'Created installed asset'
  } catch (err: unknown) {
    installedAssetSubmitError.value = err instanceof Error ? err.message : 'Failed to create installed asset'
  } finally {
    installedAssetCreating.value = false
  }
}

async function deleteInstalledAsset(asset: InstalledAssetViewModel) {
  if (!asset.id || installedAssetDeletingId.value || installedAssetUpdatingId.value || installedAssetEditingId.value === asset.id) {
    return
  }

  installedAssetDeletingId.value = asset.id
  installedAssetSubmitError.value = ''
  installedAssetSubmitSuccess.value = ''

  try {
    await readEnvelope(`/api/after-sales/installed-assets/${encodeURIComponent(asset.id)}`, {
      method: 'DELETE',
    })
    installedAssets.value = installedAssets.value.filter((item) => item.id !== asset.id)
    installedAssetsError.value = ''
    installedAssetSubmitSuccess.value = `Deleted installed asset ${asset.data.assetCode}`
  } catch (err: unknown) {
    installedAssetSubmitError.value = err instanceof Error ? err.message : 'Failed to delete installed asset'
  } finally {
    installedAssetDeletingId.value = ''
  }
}

async function submitInstalledAssetEdit(asset: InstalledAssetViewModel) {
  if (
    !asset.id ||
    installedAssetEditingId.value !== asset.id ||
    installedAssetUpdatingId.value ||
    !canSubmitInstalledAssetEdit.value
  ) {
    return
  }

  installedAssetUpdatingId.value = asset.id
  installedAssetSubmitError.value = ''
  installedAssetSubmitSuccess.value = ''

  try {
    const payload = await readEnvelope<CreateInstalledAssetResponse>(
      `/api/after-sales/installed-assets/${encodeURIComponent(asset.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(buildInstalledAssetUpdatePayload()),
      },
    )
    const nextAsset = payload?.installedAsset ? normalizeInstalledAssetRow(payload.installedAsset) : null

    if (nextAsset) {
      installedAssets.value = matchesInstalledAssetFilters(nextAsset)
        ? installedAssets.value.map((item) => (item.id === nextAsset.id ? nextAsset : item))
        : installedAssets.value.filter((item) => item.id !== nextAsset.id)
      installedAssetsError.value = ''
      installedAssetSubmitSuccess.value = `Updated installed asset ${nextAsset.data.assetCode}`
    }

    installedAssetEditingId.value = ''
    installedAssetEditDraft.value = createInstalledAssetEditDraft()
  } catch (err: unknown) {
    installedAssetSubmitError.value = err instanceof Error ? err.message : 'Failed to update installed asset'
  } finally {
    installedAssetUpdatingId.value = ''
  }
}

async function loadServiceRecordsForCurrentState(state: CurrentResponse): Promise<void> {
  serviceRecordsLoading.value = true
  serviceRecordsError.value = ''
  try {
    if (state.status === 'not-installed' || state.status === 'failed') {
      serviceRecords.value = []
      return
    }

    const payload = await readEnvelope<ServiceRecordsResponse>(buildServiceRecordListPath())
    const rows = Array.isArray(payload?.serviceRecords) ? payload.serviceRecords : []
    serviceRecords.value = rows.map((row) => normalizeServiceRecordRow(row))
  } catch (err: unknown) {
    serviceRecords.value = []
    if (state.status === 'installed' || state.status === 'partial') {
      serviceRecordsError.value = err instanceof Error ? err.message : 'Failed to load service records'
    }
  } finally {
    serviceRecordsLoading.value = false
  }
}

async function submitServiceRecord() {
  if (!canSubmitServiceRecord.value || serviceRecordCreating.value) {
    return
  }

  serviceRecordCreating.value = true
  serviceRecordSubmitError.value = ''
  serviceRecordSubmitSuccess.value = ''

  try {
    const payload = await readEnvelope<CreateServiceRecordResponse>('/api/after-sales/service-records', {
      method: 'POST',
      body: JSON.stringify(buildServiceRecordPayload()),
    })
    const nextRecord = payload?.serviceRecord ? normalizeServiceRecordRow(payload.serviceRecord) : null

    if (nextRecord && matchesServiceRecordFilters(nextRecord)) {
      serviceRecords.value = [nextRecord, ...serviceRecords.value.filter((item) => item.id !== nextRecord.id)]
      serviceRecordsError.value = ''
    }

    resetServiceRecordDraft()
    serviceRecordSubmitSuccess.value = nextRecord ? `Created service record for ${nextRecord.data.ticketNo}` : 'Created service record'
  } catch (err: unknown) {
    serviceRecordSubmitError.value = err instanceof Error ? err.message : 'Failed to create service record'
  } finally {
    serviceRecordCreating.value = false
  }
}

async function submitServiceRecordEdit(record: ServiceRecordViewModel) {
  if (
    !record.id ||
    serviceRecordEditingId.value !== record.id ||
    serviceRecordUpdatingId.value ||
    !canSubmitServiceRecordEdit.value
  ) {
    return
  }

  serviceRecordUpdatingId.value = record.id
  serviceRecordSubmitError.value = ''
  serviceRecordSubmitSuccess.value = ''

  try {
    const payload = await readEnvelope<CreateServiceRecordResponse>(
      `/api/after-sales/service-records/${encodeURIComponent(record.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(buildServiceRecordUpdatePayload()),
      },
    )
    const nextRecord = payload?.serviceRecord ? normalizeServiceRecordRow(payload.serviceRecord) : null

    if (nextRecord) {
      serviceRecords.value = matchesServiceRecordFilters(nextRecord)
        ? serviceRecords.value.map((item) => (item.id === nextRecord.id ? nextRecord : item))
        : serviceRecords.value.filter((item) => item.id !== nextRecord.id)
      serviceRecordsError.value = ''
      serviceRecordSubmitSuccess.value = `Updated service record for ${nextRecord.data.ticketNo}`
    }

    serviceRecordEditingId.value = ''
    serviceRecordEditDraft.value = createServiceRecordEditDraft()
  } catch (err: unknown) {
    serviceRecordSubmitError.value = err instanceof Error ? err.message : 'Failed to update service record'
  } finally {
    serviceRecordUpdatingId.value = ''
  }
}

async function submitTicket() {
  if (!canSubmitTicket.value || ticketCreating.value || ticketsLoading.value) {
    return
  }

  ticketCreating.value = true
  ticketSubmitError.value = ''
  ticketSubmitSuccess.value = ''

  const parsedRefundAmount = parseOptionalRefundAmount(ticketDraft.value.refundAmount)
  if (isRefundAmountEditable.value && !parsedRefundAmount.valid) {
    ticketSubmitError.value = 'Refund amount must be a valid number'
    ticketCreating.value = false
    return
  }

  try {
    const payload = await readEnvelope<CreateTicketResponse>('/api/after-sales/tickets', {
      method: 'POST',
      body: JSON.stringify(buildTicketPayload()),
    })
    const nextTicket = payload?.ticket ? normalizeTicket(payload.ticket, null) : null

    if (nextTicket) {
      tickets.value = [nextTicket, ...tickets.value.filter((item) => item.id !== nextTicket.id)]
      ticketsError.value = ''
    }

    resetTicketDraft()
    ticketSubmitSuccess.value = nextTicket ? `Created ticket ${nextTicket.data.ticketNo}` : 'Created ticket'
  } catch (err: unknown) {
    ticketSubmitError.value = err instanceof Error ? err.message : 'Failed to create after-sales ticket'
  } finally {
    ticketCreating.value = false
  }
}

async function submitTicketEdit(ticket: TicketViewModel) {
  if (!ticket.id || ticketEditingId.value !== ticket.id || ticketUpdatingId.value || !canSubmitTicketEdit.value) {
    return
  }

  ticketUpdatingId.value = ticket.id
  ticketSubmitError.value = ''
  ticketSubmitSuccess.value = ''

  try {
    const payload = await readEnvelope<CreateTicketResponse>(
      `/api/after-sales/tickets/${encodeURIComponent(ticket.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(buildTicketUpdatePayload()),
      },
    )
    const nextTicket = payload?.ticket ? normalizeTicket(payload.ticket, null) : null

    if (nextTicket) {
      if (ticket.data.refundStatus === 'pending' && nextTicket.data.refundStatus === 'pending') {
        nextTicket.approvalLabel = ticket.approvalLabel
      }
      tickets.value = matchesTicketFilters(nextTicket)
        ? tickets.value.map((item) => (item.id === nextTicket.id ? nextTicket : item))
        : tickets.value.filter((item) => item.id !== nextTicket.id)
      ticketsError.value = ''
      ticketSubmitSuccess.value = `Updated ticket ${nextTicket.data.ticketNo}`
    }

    ticketEditingId.value = ''
    ticketEditDraft.value = createTicketEditDraft()
  } catch (err: unknown) {
    ticketSubmitError.value = err instanceof Error ? err.message : 'Failed to update after-sales ticket'
  } finally {
    ticketUpdatingId.value = ''
  }
}

async function requestTicketRefund(ticket: TicketViewModel) {
  if (!ticket.id || ticketRefundSubmittingId.value || ticketUpdatingId.value || ticketEditingId.value === ticket.id) {
    return
  }
  if (!isRefundAmountEditable.value || isRefundAmountHidden.value) {
    return
  }

  const rawRefundAmount = ticketRefundDrafts.value[ticket.id] ?? formatRefundDraft(ticket.data.refundAmount)
  const parsedRefundAmount = parseOptionalRefundAmount(rawRefundAmount)
  if (!parsedRefundAmount.valid || typeof parsedRefundAmount.value !== 'number') {
    ticketRefundErrorById.value = {
      ...ticketRefundErrorById.value,
      [ticket.id]: 'Refund amount must be a valid number',
    }
    return
  }

  ticketRefundSubmittingId.value = ticket.id
  ticketSubmitError.value = ''
  ticketSubmitSuccess.value = ''
  ticketRefundErrorById.value = {
    ...ticketRefundErrorById.value,
    [ticket.id]: '',
  }

  try {
    const payload = await readEnvelope<CreateTicketResponse>(
      `/api/after-sales/tickets/${encodeURIComponent(ticket.id)}/refund-request`,
      {
        method: 'POST',
        body: JSON.stringify({
          refundAmount: parsedRefundAmount.value,
        }),
      },
    )
    const nextTicket = payload?.ticket ? normalizeTicket(payload.ticket, null) : null

    if (nextTicket) {
      tickets.value = tickets.value.map((item) => (item.id === nextTicket.id ? nextTicket : item))
      ticketRefundDrafts.value = {
        ...ticketRefundDrafts.value,
        [ticket.id]: formatRefundDraft(nextTicket.data.refundAmount),
      }
      ticketSubmitSuccess.value = `Requested refund for ${nextTicket.data.ticketNo}`
    }
  } catch (err: unknown) {
    ticketRefundErrorById.value = {
      ...ticketRefundErrorById.value,
      [ticket.id]: err instanceof Error ? err.message : 'Failed to request refund',
    }
  } finally {
    ticketRefundSubmittingId.value = ''
  }
}

async function loadFieldPoliciesForCurrentState(state: CurrentResponse): Promise<void> {
  if (state.status !== 'installed' && state.status !== 'partial') {
    ticketFieldPolicies.value = null
    return
  }

  try {
    ticketFieldPolicies.value = await readEnvelope<TicketFieldPolicyResponse>('/api/after-sales/field-policies')
  } catch {
    ticketFieldPolicies.value = null
  }
}

async function deleteTicket(ticket: TicketViewModel) {
  if (!ticket.id || ticketDeletingId.value) {
    return
  }

  ticketDeletingId.value = ticket.id
  ticketSubmitError.value = ''
  ticketSubmitSuccess.value = ''

  try {
    await readEnvelope(`/api/after-sales/tickets/${encodeURIComponent(ticket.id)}`, {
      method: 'DELETE',
    })
    tickets.value = tickets.value.filter((item) => item.id !== ticket.id)
    ticketsError.value = ''
    ticketSubmitSuccess.value = `Deleted ticket ${ticket.data.ticketNo}`
  } catch (err: unknown) {
    ticketSubmitError.value = err instanceof Error ? err.message : 'Failed to delete after-sales ticket'
  } finally {
    ticketDeletingId.value = ''
  }
}

async function applyServiceRecordFilters() {
  if (serviceRecordCreating.value || serviceRecordUpdatingId.value || serviceRecordEditingId.value) {
    return
  }
  await loadServiceRecordsForCurrentState(current.value)
}

async function resetServiceRecordFilters() {
  if (serviceRecordCreating.value || serviceRecordUpdatingId.value || serviceRecordEditingId.value) {
    return
  }
  serviceRecordFilters.value = {
    ticketNo: '',
    result: '',
    search: '',
  }
  await loadServiceRecordsForCurrentState(current.value)
}

async function refreshServiceRecords() {
  if (serviceRecordCreating.value || serviceRecordDeletingId.value || serviceRecordUpdatingId.value || serviceRecordEditingId.value) {
    return
  }
  await loadServiceRecordsForCurrentState(current.value)
}

async function deleteServiceRecord(record: ServiceRecordViewModel) {
  if (!record.id || serviceRecordDeletingId.value === record.id || serviceRecordUpdatingId.value || serviceRecordEditingId.value === record.id) {
    return
  }

  serviceRecordDeletingId.value = record.id
  serviceRecordSubmitError.value = ''
  serviceRecordSubmitSuccess.value = ''

  try {
    await readEnvelope(`/api/after-sales/service-records/${encodeURIComponent(record.id)}`, {
      method: 'DELETE',
    })
    serviceRecords.value = serviceRecords.value.filter((item) => item.id !== record.id)
    serviceRecordsError.value = ''
    serviceRecordSubmitSuccess.value = `Deleted service record for ${record.data.ticketNo}`
  } catch (err: unknown) {
    serviceRecordSubmitError.value = err instanceof Error ? err.message : 'Failed to delete service record'
  } finally {
    serviceRecordDeletingId.value = ''
  }
}

async function refreshCurrentState() {
  refreshing.value = true
  try {
    current.value = await readEnvelope<CurrentResponse>('/api/after-sales/projects/current')
    baselineConfigDraft.value = normalizeConfigDraft(current.value.config)
    await Promise.all([
      loadFieldPoliciesForCurrentState(current.value),
      loadTicketsForCurrentState(current.value),
      loadInstalledAssetsForCurrentState(current.value),
      loadCustomersForCurrentState(current.value),
      loadFollowUpsForCurrentState(current.value),
      loadServiceRecordsForCurrentState(current.value),
    ])
  } finally {
    refreshing.value = false
  }
}

async function loadView() {
  loading.value = true
  error.value = ''
  ticketsError.value = ''
  installedAssetsError.value = ''
  customersError.value = ''
  followUpsError.value = ''
  customerSubmitError.value = ''
  customerSubmitSuccess.value = ''
  followUpSubmitError.value = ''
  followUpSubmitSuccess.value = ''
  installedAssetSubmitError.value = ''
  installedAssetSubmitSuccess.value = ''
  ticketSubmitError.value = ''
  ticketSubmitSuccess.value = ''
  serviceRecordsError.value = ''
  serviceRecordSubmitError.value = ''
  serviceRecordSubmitSuccess.value = ''
  try {
    const [nextManifest, nextCurrent] = await Promise.all([
      readEnvelope<AfterSalesManifest>('/api/after-sales/app-manifest'),
      readEnvelope<CurrentResponse>('/api/after-sales/projects/current'),
    ])
    manifest.value = nextManifest
    current.value = nextCurrent
    baselineConfigDraft.value = normalizeConfigDraft(nextCurrent.config)
    configDraft.value = { ...baselineConfigDraft.value }
    await Promise.all([
      loadFieldPoliciesForCurrentState(nextCurrent),
      loadTicketsForCurrentState(nextCurrent),
      loadInstalledAssetsForCurrentState(nextCurrent),
      loadCustomersForCurrentState(nextCurrent),
      loadFollowUpsForCurrentState(nextCurrent),
      loadServiceRecordsForCurrentState(nextCurrent),
    ])
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Failed to load after-sales state'
  } finally {
    loading.value = false
  }
}

async function triggerInstall(mode: 'enable' | 'reinstall') {
  installing.value = true
  error.value = ''
  try {
    await readEnvelope('/api/after-sales/projects/install', {
      method: 'POST',
      body: JSON.stringify({
        templateId: TEMPLATE_ID,
        mode,
        displayName: current.value.displayName || manifest.value?.displayName || 'After Sales',
        config: buildInstallConfig(),
      }),
    })
    await refreshCurrentState()
    configDraft.value = { ...baselineConfigDraft.value }
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Failed to install after-sales template'
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  void loadView()
})
</script>

<style scoped>
.after-sales-view {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.after-sales-view__overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.28);
  backdrop-filter: blur(6px);
}

.after-sales-view__overlay-card,
.after-sales-view__modal {
  width: min(520px, calc(100vw - 32px));
  padding: 24px;
  border-radius: 20px;
  background: #ffffff;
  box-shadow: 0 30px 80px rgba(15, 23, 42, 0.18);
}

.after-sales-view__overlay-card {
  text-align: center;
}

.after-sales-view__spinner {
  width: 36px;
  height: 36px;
  margin: 0 auto 16px;
  border-radius: 999px;
  border: 3px solid rgba(14, 116, 144, 0.15);
  border-top-color: #0f766e;
  animation: spin 0.9s linear infinite;
}

.after-sales-view__hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 28px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(14, 116, 144, 0.1), rgba(245, 158, 11, 0.12)),
    #ffffff;
  border: 1px solid rgba(14, 116, 144, 0.14);
}

.after-sales-view__hero-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

.after-sales-view__eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #0f766e;
}

.after-sales-view__hero h1 {
  margin: 0;
  font-size: 32px;
  line-height: 1.05;
  color: #0f172a;
}

.after-sales-view__lead {
  margin: 12px 0 0;
  max-width: 680px;
  color: #334155;
}

.after-sales-view__status {
  min-width: 140px;
  padding: 10px 14px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.9);
  color: #0f172a;
  font-size: 13px;
  text-align: center;
}

.after-sales-view__status[data-tone='success'] {
  color: #166534;
  border-color: rgba(22, 101, 52, 0.18);
  background: rgba(220, 252, 231, 0.8);
}

.after-sales-view__status[data-tone='warning'] {
  color: #92400e;
  border-color: rgba(146, 64, 14, 0.18);
  background: rgba(254, 243, 199, 0.9);
}

.after-sales-view__status[data-tone='danger'] {
  color: #991b1b;
  border-color: rgba(153, 27, 27, 0.16);
  background: rgba(254, 226, 226, 0.88);
}

.after-sales-view__error-banner,
.after-sales-view__warning-banner,
.after-sales-view__config-shell,
.after-sales-view__onboarding,
.after-sales-view__tickets-shell,
.after-sales-view__installed-assets-shell,
.after-sales-view__customers-shell,
.after-sales-view__follow-ups-shell,
.after-sales-view__service-records-shell {
  display: grid;
  gap: 16px;
}

.after-sales-view__error-banner,
.after-sales-view__warning-banner {
  grid-template-columns: 1fr auto;
  align-items: center;
  padding: 18px 20px;
  border-radius: 16px;
  border: 1px solid #fecaca;
  background: #fff1f2;
}

.after-sales-view__warning-banner[data-tone='partial'] {
  border-color: #fcd34d;
  background: #fffbeb;
}

.after-sales-view__warning-banner[data-tone='failed'] {
  border-color: #fca5a5;
  background: #fef2f2;
}

.after-sales-view__error-banner p,
.after-sales-view__warning-banner p,
.after-sales-view__onboarding-card p,
.after-sales-view__card p,
.after-sales-view__muted-state,
.after-sales-view__inline-error,
.after-sales-view__inline-success {
  margin: 6px 0 0;
  color: #475569;
  line-height: 1.6;
}

.after-sales-view__inline-error {
  color: #b91c1c;
}

.after-sales-view__inline-success {
  color: #166534;
}

.after-sales-view__onboarding-card,
.after-sales-view__card {
  padding: 22px;
  border-radius: 18px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
}

.after-sales-view__card--wide {
  grid-column: 1 / -1;
}

.after-sales-view__onboarding-card {
  background:
    linear-gradient(160deg, rgba(255, 247, 237, 0.9), rgba(236, 253, 245, 0.9)),
    #ffffff;
}

.after-sales-view__content,
.after-sales-view__grid,
.after-sales-view__ticket-list,
.after-sales-view__installed-asset-list,
.after-sales-view__customer-list,
.after-sales-view__follow-up-list,
.after-sales-view__service-record-list {
  display: grid;
  gap: 16px;
}

.after-sales-view__grid {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.after-sales-view__section-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}

.after-sales-view__card h2,
.after-sales-view__onboarding-card h2,
.after-sales-view__modal h2 {
  margin: 0 0 12px;
  font-size: 18px;
  color: #0f172a;
}

.after-sales-view__list {
  margin: 0;
  padding-left: 18px;
  color: #334155;
}

.after-sales-view__list li + li {
  margin-top: 8px;
}

.after-sales-view__meta,
.after-sales-view__ticket-meta,
.after-sales-view__installed-asset-meta,
.after-sales-view__customer-meta,
.after-sales-view__follow-up-meta,
.after-sales-view__service-record-meta {
  display: grid;
  gap: 12px;
  margin: 0;
}

.after-sales-view__meta div,
.after-sales-view__ticket-meta div,
.after-sales-view__installed-asset-meta div,
.after-sales-view__customer-meta div,
.after-sales-view__follow-up-meta div,
.after-sales-view__service-record-meta div {
  display: grid;
  gap: 4px;
}

.after-sales-view__meta dt,
.after-sales-view__ticket-meta dt,
.after-sales-view__installed-asset-meta dt,
.after-sales-view__customer-meta dt,
.after-sales-view__follow-up-meta dt,
.after-sales-view__service-record-meta dt {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #64748b;
}

.after-sales-view__meta dd,
.after-sales-view__ticket-meta dd,
.after-sales-view__installed-asset-meta dd,
.after-sales-view__customer-meta dd,
.after-sales-view__follow-up-meta dd,
.after-sales-view__service-record-meta dd {
  margin: 0;
  color: #0f172a;
}

.after-sales-view__ticket-list {
  gap: 12px;
}

.after-sales-view__ticket-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
}

.after-sales-view__ticket-main {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.after-sales-view__ticket-main p {
  margin: 0;
  color: #475569;
}

.after-sales-view__ticket-headline {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.after-sales-view__ticket-headline strong {
  color: #0f172a;
}

.after-sales-view__service-record-list {
  gap: 12px;
}

.after-sales-view__customer-list {
  gap: 12px;
}

.after-sales-view__follow-up-list {
  gap: 12px;
}

.after-sales-view__installed-asset-row,
.after-sales-view__customer-row,
.after-sales-view__follow-up-row,
.after-sales-view__service-record-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
}

.after-sales-view__installed-asset-main,
.after-sales-view__customer-main,
.after-sales-view__follow-up-main,
.after-sales-view__service-record-main {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.after-sales-view__installed-asset-main p,
.after-sales-view__customer-main p,
.after-sales-view__follow-up-main p,
.after-sales-view__service-record-main p {
  margin: 0;
  color: #475569;
}

.after-sales-view__installed-asset-headline,
.after-sales-view__customer-headline,
.after-sales-view__follow-up-headline,
.after-sales-view__service-record-headline {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.after-sales-view__installed-asset-headline strong,
.after-sales-view__customer-headline strong,
.after-sales-view__follow-up-headline strong,
.after-sales-view__service-record-headline strong {
  color: #0f172a;
}

.after-sales-view__installed-asset-side,
.after-sales-view__customer-side,
.after-sales-view__follow-up-side,
.after-sales-view__service-record-side {
  display: grid;
  gap: 12px;
  justify-items: end;
}

.after-sales-view__ticket-side {
  display: grid;
  gap: 12px;
  justify-items: end;
}

.after-sales-view__ticket-actions {
  display: grid;
  gap: 8px;
  justify-items: end;
}

.after-sales-view__ticket-action-btn {
  min-width: 132px;
}

.after-sales-view__field--compact {
  width: min(220px, 100%);
}

.after-sales-view__inline-error--compact {
  max-width: 220px;
  margin: 0;
}

.after-sales-view__ticket-delete,
.after-sales-view__service-record-delete {
  min-width: 120px;
}

.after-sales-view__tag {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(14, 116, 144, 0.12);
  color: #0f766e;
}

.after-sales-view__tag--subtle {
  background: rgba(148, 163, 184, 0.14);
  color: #475569;
}

.after-sales-view__config-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.after-sales-view__installed-asset-form,
.after-sales-view__customer-form,
.after-sales-view__follow-up-form,
.after-sales-view__ticket-form,
.after-sales-view__installed-asset-filters,
.after-sales-view__customer-filters,
.after-sales-view__follow-up-filters,
.after-sales-view__service-record-form,
.after-sales-view__ticket-filters,
.after-sales-view__service-record-filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 12px;
}

.after-sales-view__ticket-form--inline {
  margin-bottom: 0;
}

.after-sales-view__field {
  display: grid;
  gap: 6px;
  color: #0f172a;
}

.after-sales-view__field span {
  font-size: 13px;
  font-weight: 600;
}

.after-sales-view__field--wide {
  grid-column: 1 / -1;
}

.after-sales-view__field-input {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  color: #0f172a;
}

.after-sales-view__field-input:focus {
  outline: 2px solid rgba(15, 118, 110, 0.28);
  outline-offset: 1px;
  border-color: #0f766e;
}

.after-sales-view__field-textarea {
  min-height: 96px;
  resize: vertical;
}

.after-sales-view__config-hint {
  margin: 14px 0 0;
  color: #475569;
}

.after-sales-view__pill {
  display: inline-flex;
  margin: 0 0 10px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(15, 118, 110, 0.12);
  color: #0f766e;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.after-sales-view__action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

.after-sales-view__action-row--compact {
  margin-top: 0;
  margin-bottom: 8px;
}

.after-sales-view__primary-btn,
.after-sales-view__ghost-btn,
.after-sales-view__close-btn {
  border: none;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.15s ease, opacity 0.15s ease;
}

.after-sales-view__primary-btn {
  padding: 11px 16px;
  background: #0f766e;
  color: #ffffff;
}

.after-sales-view__ghost-btn {
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid #cbd5e1;
  color: #0f172a;
}

.after-sales-view__close-btn {
  width: 36px;
  height: 36px;
  background: #f8fafc;
  color: #0f172a;
  font-size: 24px;
  line-height: 1;
}

.after-sales-view__primary-btn:disabled,
.after-sales-view__ghost-btn:disabled,
.after-sales-view__close-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.after-sales-view__modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 25;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.32);
}

.after-sales-view__modal-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 16px;
}

code {
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.06);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 840px) {
  .after-sales-view__hero,
  .after-sales-view__error-banner,
  .after-sales-view__warning-banner,
  .after-sales-view__ticket-row,
  .after-sales-view__installed-asset-row,
  .after-sales-view__customer-row,
  .after-sales-view__follow-up-row,
  .after-sales-view__service-record-row {
    grid-template-columns: 1fr;
    display: grid;
  }

  .after-sales-view__hero-actions {
    align-items: stretch;
  }

  .after-sales-view__section-header,
  .after-sales-view__config-form,
  .after-sales-view__installed-asset-form,
  .after-sales-view__customer-form,
  .after-sales-view__follow-up-form,
  .after-sales-view__ticket-form,
  .after-sales-view__installed-asset-filters,
  .after-sales-view__customer-filters,
  .after-sales-view__follow-up-filters,
  .after-sales-view__service-record-form,
  .after-sales-view__ticket-filters,
  .after-sales-view__service-record-filters {
    grid-template-columns: 1fr;
    display: grid;
  }

  .after-sales-view__installed-asset-side,
  .after-sales-view__customer-side,
  .after-sales-view__follow-up-side,
  .after-sales-view__service-record-side {
    justify-items: stretch;
  }

  .after-sales-view__ticket-side,
  .after-sales-view__ticket-actions {
    justify-items: stretch;
  }
}
</style>
