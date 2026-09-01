<template>
  <div class="stock-prep-install" data-testid="stock-prep-install">
    <p class="stock-prep-install__intro" data-testid="stock-prep-install-intro">
      {{ bi(
        '安装分三步:先看一遍这套部署还缺什么,再把该建的表建起来,最后回头再看一次确认建好了。这一页全是确认题,没有填空题 —— 下面列的都是默认值,您只要看一眼对不对。',
        'Installing takes three steps: check what this deployment is missing, create what needs creating, then check again to confirm it worked. Everything on this page is something to confirm, not something to fill in — the defaults are laid out below for you to look over.',
      ) }}
    </p>
    <p class="stock-prep-install__intro stock-prep-install__intro--muted" data-testid="stock-prep-install-edit-note">
      {{ bi(
        '表名和字段名是给人看的,装好之后管理员可以在多维表里改成贵司习惯的叫法 —— 系统内部不靠名字找东西,改名不会影响任何功能。所以本页不提供改名入口。',
        'Table and field names are for people to read: once installed, an admin renames them in the multitable to whatever your team calls things. Nothing in the system finds anything by its display name, so renaming breaks nothing — which is why this page offers no rename control.',
      ) }}
    </p>

    <p v-if="errorStatus !== null" class="stock-prep-install__error" data-testid="stock-prep-install-error">
      {{ bi(readFailed.zh, readFailed.en) }}
      <code class="stock-prep-install__token">HTTP {{ errorStatus }}</code>
    </p>

    <!-- ===================================================================
         §14 DEFAULTS FOR CONFIRMATION — rendered FROM the served manifest.
         Nothing below is typed here: an id this page restated would be an id
         a deployment could disagree with, which is the incident the manifest
         line exists to close.

         PLAIN FIRST (this wave): every row now leads with what the thing IS
         and what it MEANS for the reader; the identifier stays beside it,
         subordinate, because an implementer greps for it and an admin types
         it into a role editor. The bulk technical material — served notes,
         ensure paths, the raw fence contract, the acceptance statements —
         moved into the 技术详情 disclosure at the bottom of this panel.
         =================================================================== -->
    <section v-if="defaults" class="stock-prep-install__card" data-testid="stock-prep-install-defaults">
      <h3 class="stock-prep-install__h3">
        {{ bi('即将安装的内容(请您确认)', 'What will be installed (please confirm)') }}
      </h3>
      <p class="stock-prep-install__app" data-testid="stock-prep-install-app">
        <strong>{{ defaults.displayName }}</strong>
        <span v-if="defaults.version">v{{ defaults.version }}</span>
        <code class="stock-prep-install__token">{{ defaults.appId }}</code>
      </p>
      <p v-if="defaults.valueStatement" class="stock-prep-install__value" data-testid="stock-prep-install-value-statement">
        {{ defaults.valueStatement }}
      </p>

      <h4 class="stock-prep-install__h4">{{ bi('会建哪几张表', 'Which tables get created') }}</h4>
      <table class="stock-prep-install__table">
        <thead>
          <tr>
            <th>{{ bi('表名(装好后可改)', 'Table name (renameable later)') }}</th>
            <th>{{ bi('这张表用来做什么', 'What it is for') }}</th>
            <th>{{ bi('列数', 'Columns') }}</th>
            <th>{{ bi('系统内部标识(不可改)', 'Internal identifier (fixed)') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="object in defaults.objects" :key="object.id" data-testid="stock-prep-install-object-row">
            <td>
              <span data-testid="stock-prep-install-object-name">{{ object.zhName }}</span>
              <em class="stock-prep-install__tag">{{ postureLabel(object.namePosture) }}</em>
            </td>
            <td class="stock-prep-install__purpose">
              <template v-if="objectPlain(object.id)">
                {{ bi(objectPlain(object.id)!.zhNext || '', objectPlain(object.id)!.enNext || '') }}
              </template>
              <template v-else>{{ object.note || '—' }}</template>
            </td>
            <td>{{ object.columnCount ?? '—' }}</td>
            <td>
              <code v-if="object.objectId" data-testid="stock-prep-install-object-id">{{ object.objectId }}</code>
              <code v-else-if="object.objectIdNamespace" data-testid="stock-prep-install-object-namespace">
                {{ object.objectIdNamespace }}*
              </code>
              <em class="stock-prep-install__tag stock-prep-install__tag--locked">
                {{ postureLabel(object.objectIdPosture) }}
              </em>
              <small v-if="object.objectIdSource" class="stock-prep-install__hint">
                {{ bi('来源:', 'from: ') }}{{ object.objectIdSource }}
              </small>
            </td>
          </tr>
        </tbody>
      </table>

      <h4 class="stock-prep-install__h4">{{ bi('装好之后谁能做什么', 'Who can do what once it is installed') }}</h4>
      <ul class="stock-prep-install__list stock-prep-install__list--plain" data-testid="stock-prep-install-permissions">
        <li v-for="code in defaults.permissions.codes" :key="code" data-testid="stock-prep-install-permission-row">
          <strong v-if="permissionPlain(code)">{{ bi(permissionPlain(code)!.zh, permissionPlain(code)!.en) }}</strong>
          <code class="stock-prep-install__token">{{ code }}</code>
          <small v-if="permissionPlain(code)" class="stock-prep-install__hint">
            {{ bi(permissionPlain(code)!.zhNext || '', permissionPlain(code)!.enNext || '') }}
          </small>
        </li>
        <li>
          <em class="stock-prep-install__tag stock-prep-install__tag--locked">
            {{ postureLabel(defaults.permissions.posture) }}
          </em>
          <small class="stock-prep-install__hint">
            {{ bi('这三项的名字与含义由应用固定,安装过程不会改动。', 'The three are fixed by the application; installing does not change them.') }}
          </small>
        </li>
      </ul>
      <p class="stock-prep-install__hint" data-testid="stock-prep-install-permission-holders">
        {{ defaults.permissions.automaticHolders.length === 0
          ? bi(noHolders.zh + (noHolders.zhNext ?? ''), `${noHolders.en} ${noHolders.enNext ?? ''}`)
          : defaults.permissions.automaticHolders.join(', ') }}
      </p>

      <h4 class="stock-prep-install__h4">{{ bi('需要在服务器上准备的东西', 'What has to be set up on the server') }}</h4>
      <ul class="stock-prep-install__list stock-prep-install__list--plain">
        <li
          v-for="surface in defaults.configSurfaces"
          :key="surface.id"
          data-testid="stock-prep-install-config-surface"
        >
          <strong>{{ surfacePlain(surface.id) ? bi(surfacePlain(surface.id)!.zh, surfacePlain(surface.id)!.en) : surface.name }}</strong>
          <em class="stock-prep-install__tag stock-prep-install__tag--data">
            {{ bi(deploymentDataTag.zh, deploymentDataTag.en) }}
          </em>
          <small v-if="surfacePlain(surface.id)" class="stock-prep-install__hint">
            {{ bi(surfacePlain(surface.id)!.zhNext || '', surfacePlain(surface.id)!.enNext || '') }}
          </small>
          <!-- The env var NAME is a thing a person copies onto the deployment machine, so it stays
               visible. Its VALUE never crosses — the manifest names variables, never their contents. -->
          <span v-for="envVar in surface.envVars" :key="envVar" class="stock-prep-install__envvar">
            <code>{{ envVar }}</code>
          </span>
        </li>
      </ul>

      <h4 class="stock-prep-install__h4">{{ bi('系统绝对不会做的事', 'What the system will never do') }}</h4>
      <p class="stock-prep-install__hint" data-testid="stock-prep-install-no-switch">
        {{ bi(
          '下面这几条是这套部署的硬性边界。本页只报告它们的状态,没有开关可以打开它们 —— 显示「未设」或「关闭」就是正确的,不是漏配。',
          'These are hard boundaries of this deployment. This page reports their state and offers no switch to turn any of them on — "unset" or "closed" is the correct reading, not a missing setting.',
        ) }}
      </p>
      <p class="stock-prep-install__hint">
        {{ defaults.posture.installerMayModify
          ? bi(installerMayModifyWarning.zh, installerMayModifyWarning.en)
          : bi(installerMayNotModify.zh, installerMayNotModify.en) }}
      </p>
      <ul class="stock-prep-install__list stock-prep-install__list--plain">
        <li
          v-for="entry in defaults.posture.entries"
          :key="entry.id"
          data-testid="stock-prep-install-posture-entry"
        >
          <strong v-if="posturePlain(entry.id)">{{ bi(posturePlain(entry.id)!.zh, posturePlain(entry.id)!.en) }}</strong>
          <strong v-else>{{ entry.what }}</strong>
          <small v-if="posturePlain(entry.id)" class="stock-prep-install__hint">
            {{ bi(posturePlain(entry.id)!.zhNext || '', posturePlain(entry.id)!.enNext || '') }}
          </small>
          <span class="stock-prep-install__token-line">
            <code class="stock-prep-install__token">{{ entry.id }}</code>
            <code class="stock-prep-install__token">{{ entry.expectedState }}</code>
            <code v-if="entry.envVar" class="stock-prep-install__token">{{ entry.envVar }}</code>
          </span>
        </li>
      </ul>

      <h4 class="stock-prep-install__h4">{{ bi('怎么算装成功了', 'What counts as installed') }}</h4>
      <ul class="stock-prep-install__list stock-prep-install__list--plain" data-testid="stock-prep-install-acceptance">
        <li v-for="criterion in defaults.acceptance.criteria" :key="criterion.id">
          <strong v-if="acceptancePlain(criterion.id)">
            {{ bi(acceptancePlain(criterion.id)!.zh, acceptancePlain(criterion.id)!.en) }}
          </strong>
          <strong v-else>{{ criterion.statement }}</strong>
          <code class="stock-prep-install__token">{{ criterion.id }}</code>
        </li>
      </ul>
      <p class="stock-prep-install__hint">
        {{ bi(
          '这两条由随版本发布的验收脚本跑,不在本页点按钮完成 —— 脚本名在下面的技术详情里。',
          'Both are checked by the acceptance script that ships with the release, not by a button here — the script is named in the technical details below.',
        ) }}
      </p>

      <!-- Everything the page used to lead with, kept verbatim and one click away. -->
      <StockPrepTechnicalDetails testid="stock-prep-install-defaults-tech">
        <dl>
          <dt>{{ bi('清单来源', 'Manifest route') }}</dt>
          <dd><code>{{ manifestRoute }}</code></dd>
          <dt>{{ bi('建表调用(幂等)', 'Ensure calls (idempotent)') }}</dt>
          <dd>
            <ul>
              <li v-for="object in defaults.objects" :key="object.id">
                <code>{{ object.id }}</code>
                <code v-if="object.ensurePath">{{ object.ensurePath }}</code>
                <span v-if="object.note"> — {{ object.note }}</span>
              </li>
            </ul>
          </dd>
          <dt>{{ bi('权限播种策略', 'Permission seeding policy') }}</dt>
          <dd data-testid="stock-prep-install-permission-policy-note">
            {{ defaults.permissions.note || bi(
              '零自动持有:安装只把这三个码种子化,持有者为零。没有任何既有 scope 会自动变成备料 scope。',
              'Zero automatic holders: installing seeds the three codes and grants them to nobody. No existing scope silently becomes a stock-prep scope.',
            ) }}
          </dd>
          <dt>{{ bi('配置面(部署期数据 · 永不入库)', 'Config surfaces (deployment data, never stored)') }}</dt>
          <dd>
            <ul>
              <li v-for="surface in defaults.configSurfaces" :key="surface.id">
                <code>{{ surface.id }}</code>
                <code v-if="surface.serverConfigKey">{{ surface.serverConfigKey }}</code>
                <span v-for="envVar in surface.envVars" :key="envVar"> <code>{{ envVar }}</code></span>
                <span> — {{ surface.note }}</span>
              </li>
            </ul>
          </dd>
          <dt>{{ bi('围栏契约', 'Fence contract') }}</dt>
          <dd>
            <span data-testid="stock-prep-install-installer-may-modify">
              installerMayModify={{ defaults.posture.installerMayModify }}
            </span>
            <span v-if="defaults.posture.mode"> · mode={{ defaults.posture.mode }}</span>
            <div v-if="defaults.posture.note">{{ defaults.posture.note }}</div>
            <ul>
              <li v-for="entry in defaults.posture.entries" :key="entry.id">
                <code>{{ entry.id }}</code> = <code>{{ entry.expectedState }}</code>
                <span v-if="entry.envVar"> · <code>{{ entry.envVar }}</code></span>
                <span> — {{ entry.what }}</span>
              </li>
            </ul>
          </dd>
          <dt>{{ bi('验收判据(原文)', 'Acceptance criteria (as declared)') }}</dt>
          <dd>
            <ul>
              <li v-for="criterion in defaults.acceptance.criteria" :key="criterion.id">
                <code>{{ criterion.id }}</code> — {{ criterion.statement }}
              </li>
            </ul>
            <div v-if="defaults.acceptance.script">
              {{ bi('由此脚本判定:', 'Verified by: ') }}<code>{{ defaults.acceptance.script }}</code>
            </div>
            <div v-if="defaults.acceptance.runbook">
              {{ bi('操作手册:', 'Runbook: ') }}<code>{{ defaults.acceptance.runbook }}</code>
            </div>
          </dd>
        </dl>
      </StockPrepTechnicalDetails>
    </section>

    <!-- ===================================================================
         PREFLIGHT — 查. Read tier, provisions nothing. Every blocker now
         leads with what is missing and what to do about it; the route's own
         paste-able fix line stays VERBATIM inside the disclosure, because an
         operator copies that line and a rewritten fix is a wrong fix.
         =================================================================== -->
    <section class="stock-prep-install__card" data-testid="stock-prep-install-preflight">
      <h3 class="stock-prep-install__h3">{{ bi('先看看这套部署缺什么', 'First, see what this deployment is missing') }}</h3>
      <p class="stock-prep-install__hint">
        {{ bi(
          '这一步只看不动:不会创建任何东西,也不会改动任何设置。',
          'This only looks: it creates nothing and changes no setting.',
        ) }}
      </p>
      <button
        type="button"
        data-testid="stock-prep-install-preflight-run"
        :disabled="busy"
        @click="loadPreflight"
      >
        {{ bi('检查一下', 'Run the check') }}
      </button>

      <template v-if="preflight">
        <p class="stock-prep-install__ready" data-testid="stock-prep-install-preflight-result">
          <strong>{{ preflight.ready
            ? bi('都齐了,可以安装。', 'Everything is in place — ready to install.')
            : bi('还差 ' + preflight.blockers.length + ' 项,未就绪。下面逐条写了缺什么、怎么补。',
                 preflight.blockers.length + ' thing(s) still missing — not ready yet. Each one below says what is missing and how to supply it.') }}</strong>
        </p>

        <!-- The env is POLLUTED and the server withheld what is in it. A count, never the content:
             the whole point of the server-side filter is that a non-namespace allowlist entry has no
             path to this page, so the page can only ever say how many there were. -->
        <p
          v-if="pollutedAllowlistCount > 0"
          class="stock-prep-install__hint"
          data-testid="stock-prep-install-allowlist-polluted"
        >
          {{ bi(
            '服务器上「允许写入的表」这份清单里有 ' + pollutedAllowlistCount + ' 项不属于本应用的命名空间。它们没有传到本页(服务端已扣下),请到部署机上核对那一项配置。',
            pollutedAllowlistCount + ' entr(y/ies) on the server\'s "tables that may be written" list do not belong to this application\'s namespace. They never reach this page — the server withholds them — so check that setting on the deployment machine.',
          ) }}
        </p>

        <ul class="stock-prep-install__list stock-prep-install__list--plain">
          <li
            v-for="blocker in preflight.blockers"
            :key="blocker.code"
            data-testid="stock-prep-install-blocker"
          >
            <strong v-if="blockerPlain(blocker.code)">
              {{ bi(blockerPlain(blocker.code)!.zh, blockerPlain(blocker.code)!.en) }}
            </strong>
            <strong v-else>{{ blocker.what }}</strong>
            <small
              v-if="blockerPlain(blocker.code)"
              class="stock-prep-install__hint"
              data-testid="stock-prep-install-blocker-next"
            >{{ bi(blockerPlain(blocker.code)!.zhNext || '', blockerPlain(blocker.code)!.enNext || '') }}</small>
            <!-- The code stays visible: it is what an implementer greps and what we ask for in a
                 support thread. It is now subordinate to the sentence that explains it. -->
            <code class="stock-prep-install__token">{{ blocker.code }}</code>
          </li>
        </ul>

        <h4 class="stock-prep-install__h4">{{ bi('这套部署当前的边界状态', 'The boundaries, as this deployment reports them') }}</h4>
        <ul class="stock-prep-install__list stock-prep-install__list--plain">
          <li v-for="fence in postureRows" :key="fence.id" data-testid="stock-prep-install-fence">
            <span v-if="posturePlain(fence.id)">{{ bi(posturePlain(fence.id)!.zh, posturePlain(fence.id)!.en) }}</span>
            <span v-else><code>{{ fence.id }}</code></span>
            <em class="stock-prep-install__tag stock-prep-install__tag--locked">{{ fenceStateLabel(fence.state) }}</em>
          </li>
        </ul>

        <StockPrepTechnicalDetails testid="stock-prep-install-preflight-tech">
          <dl>
            <dt>{{ bi('预检路由', 'Preflight route') }}</dt>
            <dd><code>{{ preflightRoute }}</code></dd>
            <dt v-if="preflight.blockers.length > 0">{{ bi('阻断项与修复行(原样可粘)', 'Blockers and their paste-able fix lines') }}</dt>
            <dd v-if="preflight.blockers.length > 0">
              <ul>
                <li v-for="blocker in preflight.blockers" :key="blocker.code">
                  <code>{{ blocker.code }}</code> — {{ blocker.what }}
                  <!-- VERBATIM. The operator copies this line; rewriting it would be rewriting the
                       fix, so this element carries the route's own `run` string and nothing else. -->
                  <pre v-if="blocker.fix" class="stock-prep-install__run" data-testid="stock-prep-install-blocker-fix"><code>{{ blocker.fix.run }}</code></pre>
                </li>
              </ul>
            </dd>
            <dt>{{ bi('围栏姿态(服务端读数)', 'Fence posture (server reading)') }}</dt>
            <dd>
              <ul>
                <li
                  v-for="fence in postureRows"
                  :key="fence.id"
                  data-testid="stock-prep-install-preflight-posture"
                >
                  <code>{{ fence.id }}</code> = <code>{{ fence.state }}</code>
                  <span v-if="fence.envVar"> · <code>{{ fence.envVar }}</code></span>
                </li>
              </ul>
            </dd>
          </dl>
        </StockPrepTechnicalDetails>
      </template>
    </section>

    <!-- ===================================================================
         源就绪预检 + 拓扑自测 — the OTHER half of 体检.
         The section above asks what THIS deployment is missing. This one asks
         what the CUSTOMER'S source is, and measures the answer: reachable /
         has real data / which schema shape / whose schema. Read-only.
         It exists because two live failures were invisible without it — a plan
         configured for one topology against a source shaped like another (the
         run "succeeded" with zero rows), and an empty test database discovered
         many steps too late.
         =================================================================== -->
    <section class="stock-prep-install__card" data-testid="stock-prep-source-preflight">
      <h3 class="stock-prep-install__h3">{{ bi('源就绪预检:这家的库能不能接', 'Source readiness: can we connect to this customer’s database') }}</h3>
      <p class="stock-prep-install__hint">
        {{ bi(
          '这一步只读不写:去对方库里各读一小页,数一数、看一看形状,然后告诉你行不行。不会改对方任何东西。',
          'Read-only: it reads one small page from each table, counts what is there, looks at the shape, and tells you whether this will work. It changes nothing on their side.',
        ) }}
      </p>

      <button
        v-if="canCheckSource"
        type="button"
        data-testid="stock-prep-source-preflight-run"
        :disabled="busy"
        @click="loadSourcePreflight"
      >
        {{ bi('检查这个源', 'Check this source') }}
      </button>
      <p v-else class="stock-prep-install__hint" data-testid="stock-prep-source-preflight-denied">
        {{ bi(
          '这一步要读对方的库,所以只有对接权限的人能点。装配置的人看得到结果,点不了按钮。',
          'This reads the customer’s database, so only an integration role may run it. Everyone here can read the result; not everyone can press the button.',
        ) }}
      </p>

      <p
        v-if="sourcePreflightErrorStatus !== null"
        class="stock-prep-install__hint"
        data-testid="stock-prep-source-preflight-error"
      >
        {{ bi(readFailed.zh, readFailed.en) }}
        <code class="stock-prep-install__token">{{ sourcePreflightErrorStatus }}</code>
      </p>

      <template v-if="sourcePreflight">
        <p class="stock-prep-install__ready" data-testid="stock-prep-source-preflight-verdict">
          <strong>{{ sourceVerdictText }}</strong>
        </p>

        <!-- The four lines, each a SERVER measurement rendered — never a judgement made here. -->
        <ul class="stock-prep-install__list stock-prep-install__list--plain">
          <li
            v-for="row in sourceCheckRows"
            :key="row.id"
            data-testid="stock-prep-source-preflight-check"
            :data-check="row.id"
            :data-ok="row.ok ? 'yes' : 'no'"
          >
            <span
              class="stock-prep-install__status"
              :class="row.ok ? 'stock-prep-install__status--ok' : 'stock-prep-install__status--fail'"
            >{{ row.ok ? bi('是', 'yes') : bi('否', 'no') }}</span>
            <span v-if="sourceCheckPlain(row.id)">{{ bi(sourceCheckPlain(row.id)!.zh, sourceCheckPlain(row.id)!.en) }}</span>
            <span v-else><code>{{ row.id }}</code></span>
            <code class="stock-prep-install__token">{{ row.token }}</code>
          </li>
        </ul>

        <!-- The measured shape, in words. This sentence is the whole feature: an implementer used to
             have to read someone else's schema for an afternoon to learn it. -->
        <p class="stock-prep-install__hint" data-testid="stock-prep-source-preflight-shape">
          {{ bi('实测:这家的 BOM ', 'Measured: this customer’s BOM hangs ') }}
          <strong>{{ sourceBridgeText(sourcePreflight.checks.topology.detectedBridge) }}</strong>
          {{ bi(';当前配置按 ', '; the current configuration assumes it hangs ') }}
          <strong>{{ sourceBridgeText(sourcePreflight.checks.topology.configuredBridge) }}</strong>
          {{ bi(' 走。', '.') }}
          <template v-if="sourcePreflight.checks.quantityField.resolvedSlot">
            {{ bi('数量实测在 ', 'The quantity was measured in ') }}
            <code class="stock-prep-install__token">{{ sourcePreflight.checks.quantityField.resolvedSlot }}</code>
            {{ bi('。', '.') }}
          </template>
        </p>

        <ul class="stock-prep-install__list stock-prep-install__list--plain">
          <li
            v-for="blocker in sourcePreflight.blockers"
            :key="blocker.code"
            data-testid="stock-prep-source-preflight-blocker"
          >
            <strong v-if="sourceBlockerPlain(blocker.code)">
              {{ bi(sourceBlockerPlain(blocker.code)!.zh, sourceBlockerPlain(blocker.code)!.en) }}
            </strong>
            <strong v-else><code>{{ blocker.code }}</code></strong>
            <small
              v-if="sourceBlockerPlain(blocker.code)"
              class="stock-prep-install__hint"
              data-testid="stock-prep-source-preflight-blocker-next"
            >{{ bi(sourceBlockerPlain(blocker.code)!.zhNext || '', sourceBlockerPlain(blocker.code)!.enNext || '') }}</small>
            <code class="stock-prep-install__token">{{ blocker.code }}</code>
          </li>
          <li
            v-for="warning in sourcePreflight.warnings"
            :key="warning.code"
            data-testid="stock-prep-source-preflight-warning"
          >
            <span v-if="sourceWarningPlain(warning.code)">
              {{ bi(sourceWarningPlain(warning.code)!.zh, sourceWarningPlain(warning.code)!.en) }}
            </span>
            <span v-else><code>{{ warning.code }}</code></span>
            <small
              v-if="sourceWarningPlain(warning.code)"
              class="stock-prep-install__hint"
            >{{ bi(sourceWarningPlain(warning.code)!.zhNext || '', sourceWarningPlain(warning.code)!.enNext || '') }}</small>
            <code class="stock-prep-install__token">{{ warning.code }}</code>
          </li>
        </ul>

        <StockPrepTechnicalDetails testid="stock-prep-source-preflight-tech">
          <dl>
            <dt>{{ bi('预检路由', 'Preflight route') }}</dt>
            <dd><code>{{ sourcePreflightRoute }}</code></dd>
            <dt>{{ bi('被检查的数据源 / 读取配置', 'Data source checked / read plan') }}</dt>
            <dd>
              <code>{{ sourcePreflight.externalSystemId }}</code> ·
              <code>{{ sourcePreflight.readPlanId }}</code>
            </dd>
            <dt>{{ bi('每张表读了几行(上限)', 'Rows read per table (the cap)') }}</dt>
            <dd><code>{{ sourcePreflight.rowCap }}</code></dd>
            <dt>{{ bi('两条候选路的实测行数', 'Measured line counts on each candidate route') }}</dt>
            <dd>
              <ul>
                <li
                  v-for="candidate in sourcePreflight.checks.topology.candidates"
                  :key="candidate.bridge"
                  data-testid="stock-prep-source-preflight-candidate"
                >
                  <code>{{ candidate.bridge }}</code> ·
                  <code>{{ candidate.lineObject || '—' }}</code> =
                  <code>{{ candidate.lineRows }}{{ candidate.lineExact ? '' : '+' }}</code>
                </li>
              </ul>
            </dd>
            <dt>{{ bi('数量列的两种读法', 'The two readings of the quantity column') }}</dt>
            <dd>
              {{ bi('对方字段字典:', 'Their field dictionary: ') }}
              <code>{{ sourcePreflight.checks.quantityField.dictionarySlot || '—' }}</code> ·
              {{ bi('数字密度实测:', 'measured numeric density: ') }}
              <code>{{ sourcePreflight.checks.quantityField.measuredSlot || '—' }}</code> ·
              {{ bi('当前配置:', 'configured: ') }}
              <code>{{ sourcePreflight.checks.quantityField.configuredField }}</code>
            </dd>
            <dt v-if="sourcePreflight.checks.projectData.livenessSamples.length > 0">
              {{ bi('取到的项目编号(最多两个,仅证明确实有数据)', 'Project numbers seen (at most two — only to prove the data is real)') }}
            </dt>
            <dd v-if="sourcePreflight.checks.projectData.livenessSamples.length > 0">
              <code
                v-for="sample in sourcePreflight.checks.projectData.livenessSamples"
                :key="sample"
                class="stock-prep-install__token"
              >{{ sample }}</code>
            </dd>
            <dt>{{ bi('逐表读数', 'Per-table readings') }}</dt>
            <dd>
              <ul>
                <li
                  v-for="probe in sourcePreflight.probes"
                  :key="`${probe.role}:${probe.object}`"
                  data-testid="stock-prep-source-preflight-probe"
                >
                  <code>{{ probe.object }}</code> ·
                  <code>{{ probe.present ? `${probe.rowsObserved}${probe.exact ? '' : '+'}` : (probe.errorCode || 'absent') }}</code>
                </li>
              </ul>
            </dd>
          </dl>
        </StockPrepTechnicalDetails>
      </template>
    </section>

    <!-- ===================================================================
         INSTALL RUN — 补. Existing routes, existing gates, bootstrap order.
         The panel now answers 「装好了吗?」 in one line before it shows a
         single step, and every step's outcome is a word (成功 / 跳过 / 失败)
         rather than a token — with the token kept beside it for grepping.
         =================================================================== -->
    <section class="stock-prep-install__card" data-testid="stock-prep-install-run-panel">
      <h3 class="stock-prep-install__h3">{{ bi('开始安装 / 再体检一次', 'Install, or run a health check') }}</h3>

      <button
        v-if="canRun"
        type="button"
        data-testid="stock-prep-install-run"
        :disabled="busy"
        @click="startInstall"
      >
        {{ bi('开始安装(可以重复点,不会重复建)', 'Start install (safe to run again — it never creates twice)') }}
      </button>
      <p v-else class="stock-prep-install__hint" data-testid="stock-prep-install-run-denied">
        {{ bi(
          '建表这件事要由平台管理员来做。您可以看默认配置和检查结果,建表请找平台管理员执行。',
          'Creating the tables is a platform administrator\'s job. You can read the defaults and the check result; ask a platform administrator to run it.',
        ) }}
      </p>

      <p v-if="report" class="stock-prep-install__summary" data-testid="stock-prep-install-summary">
        <strong data-testid="stock-prep-install-verdict">{{ verdictText }}</strong>
        <span class="stock-prep-install__token">
          OK {{ report.okCount }} · SKIP {{ report.skipCount }} · FAIL {{ report.failCount }}<template
            v-if="!report.pass"
          > · {{ bi('停在 ', 'stopped at ') }}{{ report.failedStepId }}</template>
        </span>
      </p>

      <ol class="stock-prep-install__steps">
        <li
          v-for="row in stepRows"
          :key="row.descriptor.id"
          class="stock-prep-install__step"
          data-testid="stock-prep-install-step"
          :data-step="row.descriptor.id"
          :data-status="row.status"
        >
          <span class="stock-prep-install__status" :class="`stock-prep-install__status--${row.status}`">
            {{ statusLabel(row.status) }}
          </span>
          <span class="stock-prep-install__step-name">{{ bi(row.descriptor.zh, row.descriptor.en) }}</span>
          <!-- The raw outcome token, subordinate. A SKIP that an implementer has to grep for in a
               support thread must still BE the word SKIP somewhere on the line. -->
          <code
            v-if="row.result"
            class="stock-prep-install__token"
            data-testid="stock-prep-install-step-code"
          >{{ row.status.toUpperCase() }}</code>

          <!-- A SKIPPED step is human work outstanding, not a broken install. Its reason is rendered
               with the same weight as a successful line — hiding it is how the outstanding work goes
               unnoticed until acceptance mysteriously 409s. -->
          <small
            v-if="row.result"
            class="stock-prep-install__reason"
            data-testid="stock-prep-install-step-reason"
          >{{ reasonText(row) }}</small>
          <small v-else class="stock-prep-install__hint">{{ bi('尚未运行', 'not run yet') }}</small>

          <span
            v-for="(value, key) in (row.result ? row.result.detail : {})"
            :key="key"
            class="stock-prep-install__detail"
            data-testid="stock-prep-install-step-detail"
          >{{ key }}={{ value }}</span>
        </li>
      </ol>

      <StockPrepTechnicalDetails v-if="report" testid="stock-prep-install-run-tech">
        <dl>
          <dt>{{ bi('每一步走的路由与修复行', 'The routes each step walks, and any fix lines') }}</dt>
          <dd>
            <ul>
              <li v-for="row in stepRows" :key="row.descriptor.id">
                <code>{{ row.descriptor.id }}</code>
                <code>{{ row.status.toUpperCase() }}</code>
                <code v-if="row.result">{{ row.result.reason }}</code>
                <div><code>{{ routesOf(row.descriptor) }}</code></div>
                <pre
                  v-for="fix in (row.result ? row.result.fixes : [])"
                  :key="fix"
                  class="stock-prep-install__run"
                  data-testid="stock-prep-install-step-fix"
                ><code>{{ fix }}</code></pre>
              </li>
            </ul>
          </dd>
        </dl>
      </StockPrepTechnicalDetails>
    </section>
  </div>
</template>

<script setup lang="ts">
// BOM备料 安装页 — the page a customer admin opens to see the app's defaults, confirm them, and
// watch the system create and verify what it can.
//
// WHO THIS PAGE IS FOR (2026-08-31 rewrite). It shipped serving exactly one of its three readers —
// us. It led with `plm_stock_preparation_confirmation_decision`, `installerMayModify=false`,
// `ext-columns-written-human-band-untouched` and raw route paths, and the owner's verdict on the
// live deployment was 「这些字都太工程化,就算那些实施人员都看不懂」. The other two readers are the
// customer admin ("what will be installed, what am I confirming, did it work?") and the implementer
// ("which step failed and how do I fix it").
//
// The rewrite is PRESENTATION ONLY — same routes, same gates, same reads, same values-free posture.
// What changed is order: plain language is the default and the technical detail is one click away in
// each panel's `技术详情(排障用)` disclosure, VERBATIM. Nothing was deleted. In particular the
// preflight's paste-able `fix.run` line is reproduced byte-for-byte inside that disclosure, because
// an operator copies it and a summarised fix is a wrong fix.
//
// THREE DISCIPLINES, all inherited rather than invented here:
//
//  1. §14 (multitable-application-model-20260830.md) — "安装页展示默认配置,由客户确认". Names are
//     shown (adjusted later in the multitable), objectIds and permission codes are shown and NOT
//     editable, config surfaces are marked deployment data, and the four fences are shown WITH NO
//     SWITCH. Every value comes from the served manifest; this file restates none of them.
//  2. THE BOOTSTRAP'S STEP ORDER (scripts/ops/stock-prep-acceptance-bootstrap.mjs STEP_PLAN),
//     imported as data from installRun.ts — including the load-bearing placement of the confirmation
//     queue BEFORE acceptance.
//  3. R-11 — a control the caller cannot exercise is ABSENT. The install run drives four
//     platform-admin routes, so its button renders only for a platform admin; a `stock-prep:admin`
//     holder gets the defaults, the preflight and the fixes, and is told who runs it.
//
// VALUES-FREE. The page renders manifest constants, ids, counts, blocker codes, closed reason codes
// and the preflight's own paste-able fix lines. No customer business value and no credential can
// reach it: the manifest is a committed file that names env VARS, and the preflight is the server's
// own values-free evidence. The plain-language layer adds no new source of text — plainLanguage.ts
// is a table of committed constants keyed by identifier.
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import type { IntegrationScope } from '../../../services/integration/workbench'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  buildStockPreparationInstallDefaults,
  readStockPreparationAppManifest,
  readStockPreparationPreflight,
  StockPreparationInstallReadError,
  STOCK_PREPARATION_MANIFEST_ROUTE,
  STOCK_PREPARATION_PREFLIGHT_ROUTE,
  type StockPreparationInstallDefaults,
  type StockPreparationConfirmationPosture,
  type StockPreparationPreflight,
} from '../../../services/integration/stockPreparation/installPlan'
import {
  STOCK_PREPARATION_INSTALL_STEPS,
  createStockPreparationInstallApi,
  runStockPreparationInstall,
  type StockPreparationInstallReason,
  type StockPreparationInstallRunReport,
  type StockPreparationInstallStepDescriptor,
  type StockPreparationInstallStepResult,
  type StockPreparationInstallStepStatus,
} from '../../../services/integration/stockPreparation/installRun'
import { canRunStockPrepInstall } from '../../../services/integration/stockPreparation/workbenchAccess'
// 源就绪预检 — the source half of 体检. Its permission predicate lives in ITS OWN service and not in
// workbenchAccess.ts on purpose: the tier it needs is the integration read tier, deliberately outside
// the R-11 stock-prep namespace (a source read against the customer's system is not a queue-operator
// act), and putting a non-namespace code into that manifest would misrepresent the ladder it pins.
import {
  STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE,
  StockPrepSourcePreflightError,
  canRunStockPrepSourcePreflight,
  readStockPreparationSourcePreflight,
  stockPrepSourceCheckRows,
  type StockPrepSourcePreflight,
} from '../../../services/integration/stockPreparation/sourcePreflight'
import {
  STOCK_PREP_DEPLOYMENT_DATA_TAG,
  STOCK_PREP_INSTALLER_MAY_MODIFY_WARNING,
  STOCK_PREP_INSTALLER_MAY_NOT_MODIFY,
  STOCK_PREP_NO_AUTOMATIC_HOLDERS,
  STOCK_PREP_READ_FAILED,
  stockPrepAcceptancePlain,
  stockPrepBlockerPlain,
  stockPrepConfigSurfacePlain,
  stockPrepObjectPlain,
  stockPrepPermissionPlain,
  stockPrepPosturePlain,
  stockPrepSourceBlockerPlain,
  stockPrepSourceBridgePlain,
  stockPrepSourceCheckPlain,
  stockPrepSourceVerdictPlain,
  stockPrepSourceWarningPlain,
  stockPrepStepOutcomeText,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = defineProps<{ scope: IntegrationScope }>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const canRun = computed(() => canRunStockPrepInstall((permission) => auth.hasPermission(permission)))

const busy = ref(false)
const errorStatus = ref<number | null>(null)
const defaults = ref<StockPreparationInstallDefaults | null>(null)
const preflight = ref<StockPreparationPreflight | null>(null)
const results = ref<StockPreparationInstallStepResult[]>([])
const report = ref<StockPreparationInstallRunReport | null>(null)

// The plain-language tables, exposed to the template under short names. Each returns null for an
// identifier it does not know, and every call site falls back to the served text — a manifest that
// grows a new fence or a new criterion degrades to today's rendering rather than to a blank line.
const objectPlain = stockPrepObjectPlain
const permissionPlain = stockPrepPermissionPlain
const surfacePlain = stockPrepConfigSurfacePlain
const posturePlain = stockPrepPosturePlain
const acceptancePlain = stockPrepAcceptancePlain
const blockerPlain = stockPrepBlockerPlain
const noHolders = STOCK_PREP_NO_AUTOMATIC_HOLDERS
const deploymentDataTag = STOCK_PREP_DEPLOYMENT_DATA_TAG
const installerMayNotModify = STOCK_PREP_INSTALLER_MAY_NOT_MODIFY
const installerMayModifyWarning = STOCK_PREP_INSTALLER_MAY_MODIFY_WARNING
const readFailed = STOCK_PREP_READ_FAILED
const manifestRoute = STOCK_PREPARATION_MANIFEST_ROUTE
const preflightRoute = STOCK_PREPARATION_PREFLIGHT_ROUTE

// ---------------------------------------------------------------------------
// 源就绪预检 — its own state, its own error slot, its own permission.
//
// Deliberately NOT folded into the shared `busy` / `errorStatus` pair beyond the busy flag: a source
// check that fails must not blank the deployment preflight an operator is reading, and vice versa.
// The two answer different questions about different machines.
// ---------------------------------------------------------------------------
const sourcePreflight = ref<StockPrepSourcePreflight | null>(null)
const sourcePreflightErrorStatus = ref<number | null>(null)
const sourcePreflightRoute = STOCK_PREPARATION_SOURCE_PREFLIGHT_ROUTE
const canCheckSource = computed(() => canRunStockPrepSourcePreflight((permission) => auth.hasPermission(permission)))
const sourceBlockerPlain = stockPrepSourceBlockerPlain
const sourceWarningPlain = stockPrepSourceWarningPlain
const sourceCheckPlain = stockPrepSourceCheckPlain

const sourceCheckRows = computed(() => (sourcePreflight.value ? stockPrepSourceCheckRows(sourcePreflight.value) : []))

const sourceVerdictText = computed(() => {
  if (!sourcePreflight.value) return ''
  const plain = stockPrepSourceVerdictPlain(sourcePreflight.value.verdict)
  // Fail soft, exactly like every other lookup on this page: an unrecognised verdict renders the
  // token rather than a blank line.
  return plain ? bi(plain.zh, plain.en) : sourcePreflight.value.verdict
})

function sourceBridgeText(bridge: string): string {
  const plain = stockPrepSourceBridgePlain(bridge)
  return plain ? bi(plain.zh, plain.en) : bridge
}

async function loadSourcePreflight(): Promise<void> {
  busy.value = true
  sourcePreflightErrorStatus.value = null
  try {
    sourcePreflight.value = await readStockPreparationSourcePreflight(props.scope)
  } catch (error) {
    // Only a status reaches state. A server message could carry a value, and this page's whole
    // contract with the customer's data is that none of it lands here.
    sourcePreflightErrorStatus.value = error instanceof StockPrepSourcePreflightError ? error.status : 0
  } finally {
    busy.value = false
  }
}

/** Only an HTTP status reaches state — a server message could carry a value. */
function recordError(error: unknown): void {
  errorStatus.value = error instanceof StockPreparationInstallReadError ? error.status : 0
}

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true
  errorStatus.value = null
  try {
    await task()
  } catch (error) {
    recordError(error)
  } finally {
    busy.value = false
  }
}

async function loadDefaults(): Promise<void> {
  await run(async () => {
    defaults.value = buildStockPreparationInstallDefaults(await readStockPreparationAppManifest())
  })
}

async function loadPreflight(): Promise<void> {
  await run(async () => {
    preflight.value = await readStockPreparationPreflight(props.scope)
  })
}

async function startInstall(): Promise<void> {
  results.value = []
  report.value = null
  await run(async () => {
    const api = createStockPreparationInstallApi(props.scope)
    report.value = await runStockPreparationInstall(api, (step) => {
      // Render each step AS IT LANDS: a run that stops on step 2 must still show step 1's outcome.
      results.value = [...results.value, step]
    })
    // The run's own preflight reads are the freshest reading, so mirror the final one into the panel.
    await loadPreflight()
  })
}

onMounted(() => { void loadDefaults() })

/**
 * How many configured sandbox write-allowlist entries the SERVER withheld for sitting outside the
 * sandbox objectId namespace. A count is all that exists on this side — the entries themselves never
 * leave the plugin, which is the point of the filter in stock-preparation-preflight.cjs.
 */
const pollutedAllowlistCount = computed(() => {
  const dropped = preflight.value?.checks?.sandboxWriteAuthorization?.droppedNonNamespaceEntries
  return typeof dropped === 'number' && Number.isFinite(dropped) && dropped > 0 ? dropped : 0
})

/** The observed fence states from the preflight, as rows. */
const postureRows = computed(() => {
  const posture = preflight.value?.posture
  if (!posture || typeof posture !== 'object') return []
  return Object.keys(posture).map((id) => ({
    id,
    state: posture[id]?.state ?? '—',
    envVar: posture[id]?.envVar ?? null,
  }))
})

/** Every planned step, with its result once it has one. Pending steps are still listed. */
const stepRows = computed(() => STOCK_PREPARATION_INSTALL_STEPS.map((descriptor) => {
  const result = results.value.find((entry) => entry.id === descriptor.id) ?? null
  return {
    descriptor,
    result,
    status: (result ? result.status : 'pending') as StockPreparationInstallStepStatus,
  }
}))

/**
 * 「装好了吗?」 — answered in one sentence, before any step is read.
 *
 * The old summary was `完成 9/9 · OK 1 · SKIP 7 · FAIL 0 · 无失败`, which requires the reader to
 * already know that a SKIP is not a failure. That tally is still on the line, subordinate, because
 * an implementer scans for it; the sentence in front of it is what answers the question.
 */
const verdictText = computed<string>(() => {
  const value = report.value
  if (!value) return ''
  if (!value.pass) {
    const failed = STOCK_PREPARATION_INSTALL_STEPS.find((step) => step.id === value.failedStepId)
    const name = failed ? bi(failed.zh, failed.en) : String(value.failedStepId)
    return bi(
      `没装完:停在「${name}」这一步。下面那一行写了原因和下一步。`,
      `Not finished: it stopped at “${name}”. The line below says why, and what to do next.`,
    )
  }
  if (value.skipCount === 0) {
    return bi(
      `装好了:${value.completedSteps} 步全部成功。`,
      `Installed: all ${value.completedSteps} steps succeeded.`,
    )
  }
  return bi(
    `装好了,没有失败。${value.completedSteps} 步里 ${value.okCount} 步做完了,${value.skipCount} 步跳过 —— 跳过的是还需要人来做的事,不是装坏了,下面每一条都写了是什么。`,
    `Installed, with no failures. ${value.okCount} of ${value.completedSteps} steps are done and ${value.skipCount} were skipped — a skip is work still waiting for a person, not a broken install, and each one says what it is waiting for.`,
  )
})

function routesOf(descriptor: StockPreparationInstallStepDescriptor): string {
  return descriptor.routes.join(' · ')
}

/** 成功 / 跳过 / 失败 / 待运行 — the word, in the colour the panel already uses for that state. */
function statusLabel(status: StockPreparationInstallStepStatus): string {
  const outcome = stockPrepStepOutcomeText(status)
  return bi(outcome.zh, outcome.en)
}

function postureLabel(posture: StockPreparationConfirmationPosture): string {
  if (posture === 'confirm') return bi('可确认', 'confirm')
  if (posture === 'no-switch') return bi('无开关', 'no switch')
  return bi('不可改', 'read-only')
}

/** A fence's observed state in words. Unknown states fall through as the served token. */
function fenceStateLabel(state: string): string {
  if (state === 'closed') return bi('已关闭', 'closed')
  if (state === 'permanently_disabled') return bi('永久禁用', 'permanently off')
  if (state === 'dormant') return bi('未启用', 'not in use')
  if (state === 'unset') return bi('未配置', 'unset')
  return state
}

/**
 * The closed reason vocabulary -> prose. The only place a reason code becomes a sentence.
 *
 * Each entry now answers two questions rather than one: what happened, and — where the answer is not
 * obvious — whether it is a problem and what to do about it. A SKIP whose reason does not say "this
 * is a to-do, not a failure" is a SKIP the reader will read as a failure.
 */
const REASON_TEXT: Record<StockPreparationInstallReason, [string, string]> = {
  PREFLIGHT_READY: ['检查通过,什么都不缺。', 'The check passed — nothing is missing.'],
  PREFLIGHT_ROUTE_ABSENT: [
    '这套部署的版本比检查功能早,所以跳过了检查 —— 是版本旧,不是坏了。',
    'This deployment predates the check, so it was skipped — old, not broken.',
  ],
  PREFLIGHT_BLOCKERS_PROVISIONED_BELOW: [
    '缺的都是本次安装自己会建的表,继续往下走就补齐了。',
    'Everything missing is a table this very run creates — carry on and it gets filled in.',
  ],
  PREFLIGHT_BLOCKERS_DEPLOYMENT_DATA: [
    '缺的东西要在部署机上准备(文件或环境配置),本页没有、也不应该有输入框 —— 按技术详情里的修复行处理完再重跑。',
    'What is missing has to be supplied on the deployment machine (a file or an environment setting). This page has no field for it and must never grow one — apply the fix lines in the technical details, then run again.',
  ],
  PREFLIGHT_READ_FAILED: ['没能读到检查结果。', 'The check could not be read.'],
  LEDGER_ENSURE_FAILED: [
    '备料确认账本这张表没能建起来 —— 这一步需要平台管理员权限。',
    'The confirmation ledger table could not be created — this step needs platform-admin rights.',
  ],
  PACK_CATALOG_READ_FAILED: ['没能读到「这套部署要装哪些列」的清单。', 'The list of columns this deployment installs could not be read.'],
  PACK_CATALOG_EMPTY: [
    '客户包未配置:还没告诉系统这套部署要装哪些列,所以没有列可装。这是待办事项,不是安装失败 —— 请在部署机上放好清单文件,再回来重跑。',
    'No column list is configured, so there is nothing to install yet. That is a to-do, not a failed install — put the list on the deployment machine and run this again.',
  ],
  PACK_CATALOG_AMBIGUOUS: [
    '清单里有不止一套列,本页不替您挑 —— 装错客户的列比不装更糟。请用部署脚本指定要装哪一套。',
    'The list holds more than one set of columns and this page will not choose for you — installing another customer\'s columns is worse than installing none. Name the one you want in the deployment script.',
  ],
  SANDBOX_ENSURE_FAILED: [
    '试运行表没能建起来:表的标识必须落在本应用自己的命名空间里,服务端拒绝了这个名字。',
    'The trial-run table could not be created: its identifier has to sit inside this application\'s own namespace, and the server refused the name given.',
  ],
  MANAGED_TABLES_READY: ['表都就位了。再点一次也不会重复建。', 'The tables are in place. Running this again creates nothing new.'],
  PACK_DRY_RUN_FAILED: ['试算这一步没跑起来,所以没有动任何东西。', 'The trial calculation did not run, so nothing was touched.'],
  PACK_DRY_RUN_CONFLICTS: [
    '这些字段已经归别人管了,安装不会覆盖别人的字段 —— 请先看冲突的是哪几个,再决定怎么办。',
    'These fields already belong to something else, and the install will not overwrite them — look at which ones clash, then decide.',
  ],
  PACK_INSTALL_FAILED: ['装列没有成功。', 'Installing the columns did not succeed.'],
  PACK_INSTALL_NOT_IDEMPOTENT: [
    '第二次运行又新建了列 —— 安装本应该重复运行也不多建,这是程序缺陷,请联系我们,不是您配置的问题。',
    'A second run created columns again — installing twice is supposed to create nothing the second time, so this is a defect on our side, not a configuration problem. Please tell us.',
  ],
  PACK_INSTALLED: [
    '列都装好了,而且第二次运行确认过:重复安装不会重复建列。',
    'The columns are installed, and a second run confirmed it: installing again creates nothing.',
  ],
  MALFORMED_RESPONSE: [
    '服务器答了「成功」,但内容不是本系统的应答 —— 多半是网关或登录页替服务器答了。这一步按失败处理:告诉您表建好了而其实没建,比报失败更糟。',
    'Something answered “success” with content this system did not write — usually a gateway or a sign-in page answering in the server\'s place. Treated as a failure: telling you a table exists when it does not is worse than reporting a failure.',
  ],
  HELD_FOR_OPERATOR: ['', ''],
  RECHECK_READY: ['再检查一次:什么都不缺,装好了。', 'Checked again: nothing missing — this is installed.'],
  RECHECK_STILL_BLOCKED: [
    '再检查一次:还有没补齐的项。剩下的都是要人来做的,修复行在技术详情里。',
    'Checked again: some things are still missing. What remains needs a person; the fix lines are in the technical details.',
  ],
}

function reasonText(row: { descriptor: StockPreparationInstallStepDescriptor; result: StockPreparationInstallStepResult | null }): string {
  if (!row.result) return ''
  if (row.result.reason === 'HELD_FOR_OPERATOR') {
    return bi(row.descriptor.heldZh || '', row.descriptor.heldEn || '')
  }
  const [zh, en] = REASON_TEXT[row.result.reason]
  return bi(zh, en)
}

defineExpose({ loadDefaults, loadPreflight, loadSourcePreflight, startInstall })
</script>

<style scoped>
.stock-prep-install__intro {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-install__intro--muted {
  color: var(--ms-text-3);
}

.stock-prep-install__error {
  margin: 0 0 var(--ms-space-3);
  color: var(--el-color-danger, #c45656);
  font-size: 13px;
}

.stock-prep-install__card {
  margin-bottom: var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.stock-prep-install__h3 {
  margin: 0 0 var(--ms-space-2);
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.stock-prep-install__h4 {
  margin: var(--ms-space-3) 0 var(--ms-space-2);
  font-size: 13px;
  color: var(--ms-text-1);
}

.stock-prep-install__app {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
  margin: 0 0 var(--ms-space-2);
}

.stock-prep-install__value {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-install__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.stock-prep-install__table th,
.stock-prep-install__table td {
  padding: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  vertical-align: top;
}

.stock-prep-install__purpose {
  color: var(--ms-text-2);
  line-height: 1.6;
}

.stock-prep-install__list {
  margin: 0;
  padding-left: var(--ms-space-4);
  font-size: 13px;
  line-height: 1.7;
}

/* The plain-language lists carry a sentence per row rather than a token per row, so they lose the
   bullet and gain breathing room — a bulleted wall of prose reads as a spec, not as an answer. */
.stock-prep-install__list--plain {
  list-style: none;
  padding-left: 0;
}

.stock-prep-install__list--plain > li {
  margin-bottom: var(--ms-space-2);
}

.stock-prep-install__list--plain > li > strong {
  color: var(--ms-text-1);
}

.stock-prep-install__hint {
  display: block;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

/* A grep-able identifier that is no longer the point of the line: still selectable, still copyable,
   visibly subordinate to the sentence above it. */
.stock-prep-install__token {
  color: var(--ms-text-3);
  font-size: 11px;
  word-break: break-all;
}

.stock-prep-install__token-line {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.stock-prep-install__tag {
  display: inline-flex;
  align-items: center;
  margin-left: var(--ms-space-2);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-3);
  font-size: 11px;
  font-style: normal;
}

.stock-prep-install__tag--locked {
  color: var(--ms-text-2);
}

.stock-prep-install__tag--data {
  color: var(--ms-text-2);
}

.stock-prep-install__envvar {
  margin-left: var(--ms-space-2);
  font-size: 12px;
}

.stock-prep-install__run {
  margin: 4px 0 0;
  padding: var(--ms-space-2);
  overflow-x: auto;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12px;
}

.stock-prep-install__ready {
  margin: var(--ms-space-2) 0;
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-install__steps {
  margin: var(--ms-space-3) 0 0;
  padding-left: var(--ms-space-4);
}

.stock-prep-install__step {
  margin-bottom: var(--ms-space-2);
  font-size: 13px;
}

.stock-prep-install__status {
  display: inline-block;
  min-width: 56px;
  font-weight: var(--ms-font-weight-title);
}

.stock-prep-install__status--ok {
  color: var(--el-color-success, #529b2e);
}

.stock-prep-install__status--skip {
  color: var(--el-color-warning, #b88230);
}

.stock-prep-install__status--fail {
  color: var(--el-color-danger, #c45656);
}

.stock-prep-install__status--pending {
  color: var(--ms-text-3);
}

.stock-prep-install__step-name {
  margin-right: var(--ms-space-2);
  color: var(--ms-text-1);
}

/* A skipped step's reason carries the same weight as a successful step's line — it is the sentence
   that stops a SKIP being misread as a failure, so it must not look like a footnote. */
.stock-prep-install__reason {
  display: block;
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.6;
}

.stock-prep-install__detail {
  display: inline-block;
  margin-right: var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 11px;
}

.stock-prep-install__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  margin: var(--ms-space-3) 0 0;
  font-size: 13px;
  color: var(--ms-text-2);
}
</style>
