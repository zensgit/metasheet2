<template>
  <section class="stock-prep-gs" data-testid="stock-prep-getting-started">
    <h3 class="stock-prep-gs__title">
      {{ bi('开始使用', 'Getting started') }}
      <!-- 进度 N/7 (wireframe B, one row longer since ① became ①a + ①b). `done` only —
           未检查/看不到/需要别人做 are not progress. -->
      <span class="stock-prep-gs__progress" data-testid="stock-prep-getting-started-progress">
        {{ bi('进度', 'Progress') }} {{ progress.done }}/{{ progress.total }}
      </span>
    </h3>
    <p class="stock-prep-gs__intro" data-testid="stock-prep-getting-started-intro">
      {{ bi(
        '第一次接入,按顺序走完这七步(第①步是两件事,分成 ①a、①b),一线就能开始用了。整个过程不会碰您 ERP/K3 里的数据。任何一步都能点开看 —— 这是一张地图,不是一道闸机。',
        'First time setting up: work through these seven steps in order (the first one is two separate acts, so it is split into 1a and 1b) and the floor can start using it. None of this touches your ERP/K3 data. Any step can be opened at any time — this is a map, not a gate.',
      ) }}
    </p>

    <!-- THE SEVEN-STEP MAP. Every badge is DERIVED (gettingStarted.ts) from data this page already has
         via props — nothing here fetches. It renders on the FIRST tick, before any button anywhere on
         this page has been pressed: `steps` computes off whatever the parent already holds (all null
         on first mount, which the derivation reads as 「未检查」 / 「? 看不到」 / 「需要别人做」,
         never as a blank and never as 「没完成」). -->
    <ol class="stock-prep-gs__map" data-testid="stock-prep-getting-started-map" role="list">
      <li
        v-for="key in stepOrder"
        :key="key"
        class="stock-prep-gs__step"
        data-testid="stock-prep-getting-started-step"
        :data-step="key"
        :data-badge="steps[key]"
      >
        <span class="stock-prep-gs__glyph" :class="`stock-prep-gs__glyph--${badgeOf(key).tone}`">{{ badgeOf(key).glyph }}</span>
        <span class="stock-prep-gs__step-label">{{ bi(stepLabel(key).zh, stepLabel(key).en) }}</span>
        <span
          class="stock-prep-gs__badge"
          :class="`stock-prep-gs__badge--${badgeOf(key).tone}`"
          data-testid="stock-prep-getting-started-step-badge"
        >{{ bi(badgeOf(key).zh, badgeOf(key).en) }}</span>
        <!-- WHY the badge reads what it reads, from the same envelope the badge came from. Absent
             when no evidence exists — a row says less rather than inventing a reason. -->
        <small
          v-if="evidenceOf(key)"
          class="stock-prep-gs__evidence"
          data-testid="stock-prep-getting-started-step-evidence"
        >{{ bi(evidenceOf(key)!.zh, evidenceOf(key)!.en) }}</small>
      </li>
    </ol>

    <!-- ①a / ①b — BOTH off-page by construction; the one thing this page can do is link out.
         WHY TWO ROWS AND NOT ONE. 整合切片 (2026-09-09) folded 外接数据源 into 数据工厂's
         连接管理 section, and that section now holds TWO controls doing two different things:
         the panel at its top registers a physical connection + credentials (writes `data_sources`),
         and the editor below it creates a connection draft that REFERENCES one by `connectionId`.
         They are done at different times, by possibly different people, and — the reason the map
         had to split — they are answered by two DIFFERENT reads: ①a by the data-source registry
         (`dataSourceRegistry.ts`), ①b by the source-binding envelope. One row could only ever badge
         one of them, and it badged ①b while its sentence described ①a.

         THE LINKS ARE GATED, THE SENTENCES ARE NOT. Both destinations are the same 数据工厂 page,
         whose route declares `permissions: ['integration:write']`. A `stock-prep:admin` holder —
         the audience 交付指南 lists for 「开始使用」 — holds no `integration:write` and would be
         bounced to the home path by the router guard: a link that redirects is not an entry point,
         it is the R-11 「看得见点不动」 failure. Denied readers get the same fact in words
         instead — which permission, and who to ask — in the same shape step ②'s `denied` control
         already uses. A plain <a>, not <router-link>: this component is mounted bare in its own
         spec (no router, no router-link stub), where a <router-link> would silently resolve to
         nothing and take the link — and the step it explains — off the page. -->
    <!-- F06 (2026-09-10 对抗复核): a `bridge:legacy-sql-readonly` deployment can NEVER be offered a
         `data-source:sql-readonly` system — the server narrows `eligibleSources` to the action's own
         frozen kind — so ①a and ①b are not 「还没做」 for it, they are NOT ITS STEPS. Before this,
         such a deployment was told to go register a data source the action cannot use, and ①b's
         evidence called its working configuration 「都是旧式桥接」 as though that were a shortfall.
         One sentence replaces both instructions; the two MAP ROWS stay (G5 — the map is not a gate,
         and a step that does not apply still has to be visible with its reason). -->
    <p
      v-if="isLegacyBridgeDeployment"
      class="stock-prep-gs__hint"
      data-testid="stock-prep-getting-started-step-source-legacy-bridge"
    >
      {{ bi(
        '本部署走的是旧式桥接(bridge:legacy-sql-readonly),连接信息就在桥接自身上 —— ①a「登记外接数据源」与 ①b「新增 SQL 绑定」对本部署不适用,不用去数据工厂登记。',
        'This deployment runs on the legacy bridge (bridge:legacy-sql-readonly), which carries its own connection details — (1a) “register the external data source” and (1b) “add the SQL binding” do not apply here, and there is nothing to register in Data Factory.',
      ) }}
    </p>
    <p v-if="!isLegacyBridgeDeployment && steps['source-register'] !== 'done'" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-step-source-register">
      {{ bi(
        '①a 先把对方的数据库登记成一条外接数据源(填地址与登录凭据,并点一下测试连接)。',
        '(1a) First register the customer’s database as an external data source — its address and sign-in credentials — and press its test-connection button once.',
      ) }}
      <a
        v-if="props.canOpenDataFactory"
        href="/integrations/workbench#int-sec-connection"
        data-testid="stock-prep-getting-started-link-data-sources"
      >{{ bi('去数据工厂 · 连接管理(分区顶部的「外接数据源」) ↗', 'Open Data Factory · Connections (the “External data sources” panel at the top) ↗') }}</a>
      <span v-else data-testid="stock-prep-getting-started-link-data-sources-denied">{{ bi(
        '登记外接数据源需要数据工厂权限(integration:write),请联系实施在数据工厂 · 连接管理里登记。',
        'Registering an external data source needs Data Factory permission (integration:write) — ask your implementer to register it under Data Factory · Connections.',
      ) }}</span>
    </p>
    <p v-if="!isLegacyBridgeDeployment && steps['source-connect'] !== 'done'" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-step-source-connect">
      {{ bi(
        '①b 再在同一个分区下方的「新增连接草稿」里建一条 SQL 只读绑定,引用 ①a 那条数据源 —— 备料能选的是这条绑定,不是数据源本身。',
        '(1b) Then, in “New connection draft” lower down that same section, create a read-only SQL binding that references the data source from (1a) — what stock-prep can pick is the binding, not the data source itself.',
      ) }}
      <a
        v-if="props.canOpenDataFactory"
        href="/integrations/workbench#int-sec-connection"
        data-testid="stock-prep-getting-started-link-connection-draft"
      >{{ bi('去数据工厂 · 连接管理(分区下方的「新增连接草稿」) ↗', 'Open Data Factory · Connections (“New connection draft”, lower in the section) ↗') }}</a>
      <span v-else data-testid="stock-prep-getting-started-link-connection-draft-denied">{{ bi(
        '新增 SQL 绑定同样需要数据工厂权限(integration:write),请让同一位实施顺手把这条绑定也建了。',
        'Adding the SQL binding needs the same Data Factory permission (integration:write) — ask the same implementer to create it while they are there.',
      ) }}</span>
    </p>

    <!-- ② 证明它只能读 — 线框 B says 「在哪做 = 本页」, and P1-1 is what made that need saying: when
         the wizard has a rail item of its own, the 源就绪预检 card that carries this action stays
         behind on 数据来源与体检. Without an entry point here, ② would read 「未检查」 forever on the
         one page the ruling lands a new deployment's admin on, with nothing on screen to check it
         with. Absent (`'none'`) whenever that card IS on screen — one action, one control. -->
    <p
      v-if="props.sourceCheckControl === 'run'"
      class="stock-prep-gs__hint"
      data-testid="stock-prep-getting-started-step-source-verify"
    >
      {{ bi(
        '②「证明它只能读」要真跑一次才有答案 —— 只读一小页,不动对方任何东西。',
        'Step ② only has an answer once it has actually been run — it reads one small page and changes nothing on their side.',
      ) }}
      <button
        type="button"
        class="stock-prep-gs__button"
        data-testid="stock-prep-getting-started-run-source-preflight"
        :disabled="props.busy"
        @click="emit('run-source-preflight')"
      >{{ bi('检查这个源', 'Check this source') }}</button>
    </p>
    <p
      v-else-if="props.sourceCheckControl === 'denied'"
      class="stock-prep-gs__hint"
      data-testid="stock-prep-getting-started-step-source-verify-denied"
    >
      {{ bi(
        '②「证明它只能读」要读对方的库,所以只有对接权限的人能跑。您看得到结果,点不了这一步。',
        'Step ② reads the customer’s database, so only an integration role may run it. You can read the result; you cannot run it yourself.',
      ) }}
    </p>

    <!-- ④ 建表 + 装列 — the one step this page actually DRIVES. Blockers split by fix.kind (I-8/I-9):
         an `http` blocker's next-step sentence points at THE card's own 「开始安装」 and carries the
         "重复点是安全的" reassurance; an `env` blocker gets no fix path at all — only a copy-for-ops
         line, because no input on this page can supply deployment-machine data (G6 restated for
         buttons: a control the page cannot back is absent, not disabled).

         ONE PRIMARY PER SCREEN (G1). Wireframe B puts a single ★[开始安装] at the FOOT of this card
         and gives the http rows a sentence, not a button of their own. An earlier cut put a fix
         button on every http row as well, which meant one action rendered up to three times on one
         screen — the exact "两卡长得像" confusion I-11 exists to prevent, reproduced within a card. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-step-install">
      <h4 class="stock-prep-gs__h4">{{ bi('④ 建表 + 装列', '④ Create tables and install columns') }}</h4>

      <template v-if="props.preflight && !props.preflight.ready">
        <ul class="stock-prep-gs__list">
          <li
            v-for="blocker in preflightBlockers"
            :key="blocker.code"
            class="stock-prep-gs__blocker"
            data-testid="stock-prep-getting-started-blocker"
            :data-fix-kind="blockerKind(blocker)"
          >
            <strong v-if="blockerPlain(blocker.code)">{{ bi(blockerPlain(blocker.code)!.zh, blockerPlain(blocker.code)!.en) }}</strong>
            <strong v-else>{{ blocker.what }}</strong>
            <small v-if="blockerPlain(blocker.code)" class="stock-prep-gs__hint">
              {{ bi(blockerPlain(blocker.code)!.zhNext || '', blockerPlain(blocker.code)!.enNext || '') }}
            </small>
            <code class="stock-prep-gs__token">{{ blocker.code }}</code>

            <!-- http: the idempotency reassurance, next to the card's own 「开始安装」 further down
                 (I-7/I-8). Suppressed for a caller who cannot see that button: a reassurance about
                 pressing a control the reader does not have is worse than silence. -->
            <span v-if="blockerKind(blocker) === 'http'" class="stock-prep-gs__blocker-action">
              <small
                v-if="props.canRunInstall"
                class="stock-prep-gs__hint"
                data-testid="stock-prep-getting-started-blocker-safe-note"
              >{{ bi('用下面的「开始安装」补齐;重复点是安全的。', 'Use “Start install” below to supply it — pressing it again is safe.') }}</small>
            </span>

            <!-- env: NO "立即修复" button — this page has no field for deployment-machine data and
                 must never grow one (STOCK_PREP_BLOCKER_PLAIN's own discipline). Copy only. -->
            <span v-else class="stock-prep-gs__blocker-action">
              <button
                type="button"
                class="stock-prep-gs__button"
                data-testid="stock-prep-getting-started-blocker-copy"
                @click="copyBlockerForOps(blocker)"
              >{{ blockerCopyLabel === 'copy' ? bi('复制这条给运维', 'Copy this for ops') : bi('已复制', 'Copied') }}</button>
            </span>
          </li>
        </ul>
      </template>
      <p v-else-if="props.preflight && props.preflight.ready" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-install-ready">
        {{ bi('都齐了,可以安装。', 'Everything is in place — ready to install.') }}
      </p>
      <p v-else class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-install-not-started">
        {{ bi('还没检查过。', 'Not checked yet.') }}
      </p>

      <!-- The run controls. "只检查" is a READ (stock-prep:read tier — the same route the ungated
           preflight-check button below this wizard already exposes to a workbench admin), so it is
           NEVER gated here either — R-11 the other direction: a control the caller CAN exercise must
           not be hidden. "开始安装" stays platform-admin only (R-11), and neither is ever gated on
           blocker CONTENT, so ledger-not-ready (or any other http blocker) never locks it (G5). -->
      <div class="stock-prep-gs__actions">
        <template v-if="props.canRunInstall">
          <button
            type="button"
            class="stock-prep-gs__button"
            :class="{ 'stock-prep-gs__button--primary': !showCompletion }"
            data-testid="stock-prep-getting-started-run-install"
            :disabled="props.busy"
            @click="emit('run-install')"
          >{{ bi('开始安装', 'Start install') }}</button>
        </template>
        <button
          type="button"
          class="stock-prep-gs__button"
          data-testid="stock-prep-getting-started-check-preflight"
          :disabled="props.busy"
          @click="emit('run-preflight-check')"
        >{{ bi('只检查,先不装', 'Check only, do not install') }}</button>
        <small v-if="props.canRunInstall" class="stock-prep-gs__hint">
          {{ bi('这会把该建的都建一遍。已经建好的不会重复建,重复点是安全的。', 'This creates everything that still needs creating. What already exists is not created twice — running it again is safe.') }}
        </small>
      </div>
      <div v-if="!props.canRunInstall" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-install-held">
        <p>{{ bi('这一步不归您做。建表要平台管理员来做,您这边能做的是把要做的事说清楚交出去:', 'This is not your step — creating tables is a platform administrator’s job. What you can do is hand it off with the details already spelled out:') }}</p>
        <button
          type="button"
          class="stock-prep-gs__button"
          :class="{ 'stock-prep-gs__button--primary': !showCompletion }"
          data-testid="stock-prep-getting-started-copy-todo-install"
          @click="copyInstallTodo"
        >{{ installTodoCopyLabel === 'copy' ? bi('复制一份待办给平台管理员', 'Copy a to-do for a platform administrator') : bi('已复制', 'Copied') }}</button>
      </div>
    </section>

    <!-- ⑤ 谁能用 — the LIVE check (P1-3 / line B2). The three permission codes are still the same
         authored table the install page's own §14 defaults panel renders; what is new below them is
         a real read of the PLATFORM role catalog, projected to role names and integer counts only.
         No user id, email or display name is fetched, so none can be rendered. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-step-grant-access">
      <h4 class="stock-prep-gs__h4">{{ bi('⑤ 谁能用', '⑤ Who can use it') }}</h4>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '装好之后,系统不会自动给任何人权限。要让一线能打开这个页面,得先把下面的权限挂到一个角色上,再把人放进那个角色。',
          'Once installed, nobody gets any permission automatically. For the floor to open this page, these permissions have to be attached to a role, and people placed in that role.',
        ) }}
      </p>
      <ul class="stock-prep-gs__list stock-prep-gs__list--plain" data-testid="stock-prep-getting-started-permission-list">
        <li v-for="code in accessCodes" :key="code" data-testid="stock-prep-getting-started-permission-row">
          <code class="stock-prep-gs__token">{{ code }}</code>
          <!-- B2 wants a sentence beside EVERY code. A manifest that grows a code this table has no
               words for still gets one, rather than a bare token nobody can act on. -->
          <span v-if="permissionPlain(code)">{{ bi(permissionPlain(code)!.zh, permissionPlain(code)!.en) }}</span>
          <span v-else>{{ bi('这条权限的说明本页还没有;请在角色管理里按这个代码查。', 'This page has no wording for this code yet — look it up by the code in Role Management.') }}</span>
        </li>
      </ul>
      <p class="stock-prep-gs__hint">
        <!-- The two codes BY NAME (B2's own sentence). An earlier cut said 「查看和填写两项都要」,
             which is a third name for the same two things the list directly above calls
             `stock-prep:read` and `stock-prep:operate`. -->
        {{ bi('一线要能干活,stock-prep:read 和 stock-prep:operate 两个都要,少一个就只能看不能做。', 'For the floor to do the work, both stock-prep:read and stock-prep:operate are needed — missing either leaves them able to look but not act.') }}
      </p>

      <!-- 现在的情况 (线框 B2) — THE ONE LIVE READ IN THIS COMPONENT.
           Four verdicts, and none of them is 「没完成」: ✔ 有角色有人 / ⚠ 有角色没人 / ⚠ 没有这样的角色
           / ? 看不到. The last one is what a `stock-prep:admin` holder sees, because the catalog route
           is platform-admin — and telling them 「还没配」 would push them to redo work that may well
           already be done (G4). Nothing in this block gates anything: every button and link in this
           card stays live in all four states (G5). -->
      <p class="stock-prep-gs__probe-label" data-testid="stock-prep-getting-started-access-label">
        {{ bi('现在的情况', 'Where this stands right now') }}
      </p>
      <div
        class="stock-prep-gs__probe"
        data-testid="stock-prep-getting-started-access-state"
        :data-state="accessStateKey"
      >
        <p class="stock-prep-gs__probe-headline">
          <span class="stock-prep-gs__glyph" :class="`stock-prep-gs__glyph--${accessVerdict.tone}`">{{ accessVerdict.glyph }}</span>
          <span data-testid="stock-prep-getting-started-access-headline">{{ bi(accessVerdict.zh, accessVerdict.en) }}</span>
        </p>
        <!-- Role NAMES and integer COUNTS. That is the whole projection `onboardingReadiness.ts`
             hands over — there is no user id, email or display name anywhere in it to render. -->
        <ul v-if="accessRoles.length > 0" class="stock-prep-gs__list stock-prep-gs__list--plain">
          <li v-for="(role, index) in accessRoles" :key="index" data-testid="stock-prep-getting-started-access-role">
            <code class="stock-prep-gs__token">{{ role.name ?? bi('(这个角色没有名字)', '(unnamed role)') }}</code>
            <span>{{ bi(`${role.memberCount} 人`, `${role.memberCount} member(s)`) }}</span>
          </li>
        </ul>
        <p v-if="accessRoleOverflow > 0" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-overflow">
          <!-- WHICH ones were listed is a fact about the catalog's own ordering, not a ranking this
               page made. Saying so stops 「主要的那几个」 being read into an `ORDER BY id`. -->
          {{ bi(
            `还有 ${accessRoleOverflow} 个角色也满足,这里没有全部列出 —— 上面那几个是角色目录返回的前几个,不是「最主要的」。`,
            `${accessRoleOverflow} further role(s) also qualify and are not listed — the ones above are simply the first the catalog returned, not the "main" ones.`,
          ) }}
        </p>
        <p v-if="accessDoubleCounted" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-double-count">
          {{ bi(
            '人数是各角色成员数相加;同时在两个角色里的人会被数两次。',
            'The headcount is the sum of the roles’ member counts; anyone in two of these roles is counted twice.',
          ) }}
        </p>
        <p v-if="accessVerdict.nextZh" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-next">
          {{ bi(accessVerdict.nextZh, accessVerdict.nextEn) }}
        </p>
        <p v-if="accessAdminNote" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-admin-note">
          {{ bi(accessAdminNote.zh, accessAdminNote.en) }}
        </p>
        <!-- Platform-admin roles satisfy the gate through the short-circuit, so they are NOT missing
             from the picture — they are deliberately outside the verdict, and the page says which. -->
        <p v-if="accessPlatformAdminNote" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-platform-admin-note">
          {{ bi(accessPlatformAdminNote.zh, accessPlatformAdminNote.en) }}
        </p>
        <!-- THE THIRD LEG, said in every verdict that is not 「看不到」. Two of the three conditions
             are readable here; this one is a per-person switch on another page, and a wizard that
             stopped at two would send an administrator away believing the floor can work. -->
        <p v-if="accessStateKey !== 'unknown'" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-admission">
          {{ bi(
            '还有一件本页看不到的事:角色配好、人也放进去之后,平台管理员还要到「用户管理」找到这个人 →「插件使用」→ 把 stock-prep 开通(那一行显示「当前实际可用」才算数)。把已有的人加进角色不会自动开通它,漏了这一步,人打开备料仍然是没权限。',
            'One more thing this page cannot see: after the role is set up and the people are in it, a platform administrator still has to open User Management → that person → "Plugin access" → enable stock-prep (the row has to read "currently effective"). Adding an existing person to a role does not enable it automatically, and without it they still get refused.',
          ) }}
        </p>
        <!-- F9, said out loud: the catalog SQL has no tenant predicate, so this is a platform-wide
             answer. An earlier draft called it 「贵司的配置」, which would have been a plain lie on a
             host serving more than one tenant. -->
        <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-scope">
          {{ bi(
            '这里读的是平台的角色目录(整个平台一份,不按租户划分),看的是「有没有这样的角色、里面有几个人」。权限只能通过角色给 —— 直接把权限码勾在某个人身上不生效,那个账号打开备料仍然是没权限。',
            'This reads the platform-wide role catalog (one catalog for the whole platform, not per tenant) and answers only “is there such a role, and how many people are in it”. Permissions only take effect through a role — ticking a code directly on a person does not work, and that account still gets refused.',
          ) }}
        </p>
        <button
          type="button"
          class="stock-prep-gs__button"
          data-testid="stock-prep-getting-started-access-recheck"
          :disabled="accessChecking"
          @click="checkAccessReadiness"
        >{{ accessChecking ? bi('正在看…', 'Checking…') : bi('重新检查', 'Check again') }}</button>
      </div>

      <!-- Native anchors, deliberately: these leave the workbench for two platform routes, and a
           full page load is the honest thing for a destination this SPA route does not own. They are
           also what keeps this component mountable in a bare `createApp` host with no router
           installed (F3: the stock-prep specs mount exactly that way). -->
      <div class="stock-prep-gs__actions">
        <a href="/admin/roles" data-testid="stock-prep-getting-started-link-roles">{{ bi('去配角色 ↗', 'Go configure roles ↗') }}</a>
        <a href="/admin/users" data-testid="stock-prep-getting-started-link-users">{{ bi('去把人放进角色 ↗', 'Go add people to the role ↗') }}</a>
      </div>
      <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-fallback">
        {{ bi(
          '这两个页面需要平台管理员权限;打不开就用下面这个把事交出去。',
          'Both pages need platform-administrator rights; if they will not open, hand the work off with the button below instead.',
        ) }}
      </p>
      <button
        type="button"
        class="stock-prep-gs__button"
        data-testid="stock-prep-getting-started-copy-todo-access"
        @click="copyAccessTodo"
      >{{ accessTodoCopyLabel === 'copy' ? bi('复制一份待办给平台管理员', 'Copy a to-do for a platform administrator') : bi('已复制', 'Copied') }}</button>
    </section>

    <!-- ⑥ 拿一个项目跑一遍 — held in P0 (no embedded project-sync panel yet). The link is NEVER
         conditioned on the source verdict: a `no-go` reading does not lock this step (G5) because
         nothing here reads `sourcePreflight.verdict` at all. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-step-first-run">
      <h4 class="stock-prep-gs__h4">{{ bi('⑥ 拿一个项目跑一遍', '⑥ Run one project through it') }}</h4>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '正式验收由随版本发布的脚本判定,不在本页点按钮完成。这一步是浏览器里的一次试算:找一个项目,从 PLM 拉一遍,看结果对不对。',
          'Formal acceptance is judged by the script that ships with the release, not by a button here. This step is a trial run in the browser: pick a project, pull it from PLM, and see whether the result looks right.',
        ) }}
      </p>
      <button
        type="button"
        class="stock-prep-gs__button"
        data-testid="stock-prep-getting-started-go-project-board"
        @click="emit('navigate-stage', 'project-board')"
      >{{ bi('去项目备料页试一遍', 'Go try it on the project board') }}</button>
      <!-- Line B3's closing ⓘ, which BOTH source drafts dropped. The project board reads through the
           operator (per-factory) value plane, and a platform administrator with no factory of their
           own is refused there — so this button can genuinely land its most likely presser on a page
           they cannot use. Said up front rather than discovered as an unexplained refusal. -->
      <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-first-run-tenancy">
        {{ bi(
          '提示:如果您这个账号没有归属到某一家工厂,这个项目页您自己可能打不开(它按工厂取数)。这不影响一线使用 —— 让一线的同事试这一步就行。',
          'Note: if your account does not belong to any one factory, this project page may not open for you (it reads per factory). That does not affect the floor — have a colleague on the floor run this step instead.',
        ) }}
      </p>
    </section>

    <!-- THE NINE-STEP INSTALL PLAN, as ONE LINE plus the part the page below does not say.
         (design §6.1 acceptance #5, design 流程3「向导只给一行摘要 + 链接」.)

         The install panel further down this same page ALREADY renders all nine steps with their live
         status — re-rendering the same nine rows here made one plan look like two, from the same
         data, with the same statuses. What that panel does NOT render before a run is WHY the five
         non-driven steps will report SKIP: it shows only 「尚未运行」. So this section keeps exactly
         that missing half — the held explanations, unprompted, before any button is pressed — and
         hands the status half to the one panel that owns it.

         Every sentence is the text `STOCK_PREPARATION_INSTALL_STEPS` already carries (installRun.ts);
         nothing here re-authors it, so the two surfaces cannot disagree. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-plan">
      <h4 class="stock-prep-gs__h4">{{ bi('安装一共九步', 'The install plan is nine steps') }}</h4>
      <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-plan-summary">
        {{ bi(
          `其中 ${drivenCount} 步「开始安装」会自己跑完;剩下 ${heldCount} 步系统不会替您做,会记成「跳过」—— 跳过不等于失败。每一步的实时状态在本页下方「开始安装 / 再体检一次」那一段里逐条列着。`,
          `${drivenCount} of them run themselves when you press Start install; the other ${heldCount} are not something the system does for you and will be recorded as SKIP — a skip is not a failure. Live per-step status is listed further down this page, under “Install, or run a health check”.`,
        ) }}
      </p>
      <h5 class="stock-prep-gs__h5">{{ bi('要人来做的那几步,以及为什么', 'The steps that need a person, and why') }}</h5>
      <ul class="stock-prep-gs__plan">
        <li
          v-for="row in heldPlanRows"
          :key="row.id"
          class="stock-prep-gs__plan-row"
          data-testid="stock-prep-getting-started-plan-held-step"
          :data-step="row.id"
        >
          <span>{{ bi(row.zh, row.en) }}</span>
          <small class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-plan-held">
            {{ bi(row.heldZh || '', row.heldEn || '') }}
          </small>
        </li>
      </ul>
    </section>

    <!-- THE HAND-OFF CARD — appears once the install run itself reports pass.
         WHAT `pass` ACTUALLY MEANS, and what this card is therefore allowed to say.
         `installRun.ts` computes `pass = failed === null` and says so in its own words: "A run that
         is all SKIP still passes — held is not broken". Five of the nine steps are `driven: false`
         and can only ever SKIP in this wave. So `pass === true` means EXACTLY 「该建的都建好了,没有
         失败」 — it does not mean a project was pulled, and it certainly does not mean the two
         script-judged acceptance criteria hold. An earlier cut of this card led with 「装好了,而且
         真的跑通了一次」 while the map two screens up still read 「⑥ 拿一个项目跑一遍 ⚑ 需要别人做」:
         one page, two answers, and the confident one was the false one (design line 244「向导不冒充
         它们」, G4). The heading below now says only what `pass` supports, and names the count of what
         is still outstanding. -->
    <section v-if="showCompletion" class="stock-prep-gs__card stock-prep-gs__card--complete" data-testid="stock-prep-getting-started-complete">
      <h4 class="stock-prep-gs__h4" data-testid="stock-prep-getting-started-complete-verdict">
        {{ bi(
          `该建的都建好了,没有失败。还有 ${outstandingSteps} 步要人来做 —— 上面每条写了是什么。`,
          `Everything that needed creating is created, with no failures. ${outstandingSteps} step(s) still need a person — each one is spelled out above.`,
        ) }}
      </h4>
      <p class="stock-prep-gs__hint">
        <!-- 「落在哪个 tab」 IS A FACT ABOUT THE SHELL, not a wish: `landsOnStockPrepProjectBoard`
             sends a read+operate holder to the project board, and the confirmation queue is where a
             read-only account lands. This card is copied into a customer group chat, so it names
             neither — it names the address and what to do there. -->
        {{ bi(
          '接下来把它交给一线:把下面这个地址发给他们,让他们用自己的账号打开。',
          'Next, hand it to the floor: send them the address below and have them open it with their own account.',
        ) }}
      </p>
      <!-- 线框 B3 第 2 行, AND the fix for a card that used to contradict the step⑤ two screens up:
           `report.pass` says the install run had no failure, and says NOTHING about who may open the
           page. Handing the address to the floor before step⑤ is done sends them to a 403, so this
           line carries step⑤'s own current answer rather than assuming it. It never gates the
           buttons (G5) — it tells the reader what they are about to hand over. -->
      <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-complete-access">
        {{ bi(handoffReadiness.zh, handoffReadiness.en) }}
      </p>
      <div class="stock-prep-gs__actions">
        <button type="button" class="stock-prep-gs__button stock-prep-gs__button--primary" data-testid="stock-prep-getting-started-copy-handoff" @click="copyHandoffMessage">
          {{ handoffCopyLabel === 'copy' ? bi('复制一段发群里', 'Copy a message for the group chat') : bi('已复制', 'Copied') }}
        </button>
        <button type="button" class="stock-prep-gs__button" data-testid="stock-prep-getting-started-copy-link" @click="copyWorkbenchLink">
          {{ linkCopyLabel === 'copy' ? bi('复制链接', 'Copy link') : bi('已复制', 'Copied') }}
        </button>
      </div>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '还没做的:拿一个项目实际跑一遍(第⑥步,本页不替您跑)。正式验收的两条(数据真的写进去了 / 再同步一次不重复写)由随版本发布的脚本判定,不在本页点按钮完成。',
          'Not done yet: actually running one project through it (step ⑥ — this page does not run it for you). The two formal acceptance criteria (the data really landed / syncing again writes nothing twice) are judged by the release script, not by a button here.',
        ) }}
      </p>
    </section>
  </section>
</template>

<script setup lang="ts">
// BOM备料 接入向导「开始使用」(P0-4) — a二级视图寄生在既有 install tab 顶部,零 tab 结构改动。
//
// PRESENTATIONAL, WITH EXACTLY ONE READ OF ITS OWN. Every prop below is state
// `StockPreparationInstallView.vue` already owns and already loads through its EXISTING calls
// (manifest, deployment preflight, source preflight, the install run). That is what makes "在没点任何
// 按钮之前就渲染" true for free: the parent's initial state (preflight=null, sourcePreflight=null,
// report=null) IS the wizard's "nothing run yet" rendering, and the parent's existing buttons driving
// this component's emits is what keeps D6 (source preflight never auto-runs) true without this file
// having to know the rule.
//
// THE ONE EXCEPTION IS ⑤「谁能用」 (P1-3). No existing call on the install page answers "is anybody
// authorised to use this yet", and the answer lives on a PLATFORM route (`/api/admin/roles`) that has
// nothing to do with the install page's own state — so threading it through the parent would have
// made `StockPreparationInstallView.vue` the owner of a read it has no other use for. It is issued
// here instead, on mount and on 「重新检查」, through `onboardingReadiness.ts`, which never rejects and
// collapses every refusal (403 for a 备料 admin, 500, network, unrecognised shape) into ONE `unknown`
// state. D6 is untouched: that rule is about probing the CUSTOMER's database, and this reads the
// platform's own role table. G3 is honoured by construction — a preload that cannot answer produces a
// state, never a banner and never a redirect.
//
// STEPPER IS A MAP, NOT A GATE (G5). No button here is ever disabled by another step's state — see
// the two design-mandated cases: a `no-go` source verdict never disables ⑥'s link (nothing here reads
// the verdict for that link at all), and an outstanding `STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY`
// blocker (an `http`-kind blocker) never disables ④'s "开始安装" button (its `:disabled` is
// `busy` alone).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'
import type { StockPreparationInstallDefaults, StockPreparationPreflight, StockPreparationPreflightBlocker } from '../../../services/integration/stockPreparation/installPlan'
import type { StockPreparationInstallRunReport } from '../../../services/integration/stockPreparation/installRun'
import { STOCK_PREPARATION_INSTALL_STEPS } from '../../../services/integration/stockPreparation/installRun'
import type { StockPrepSourcePreflight } from '../../../services/integration/stockPreparation/sourcePreflight'
import {
  STOCK_PREP_GETTING_STARTED_BADGE,
  STOCK_PREP_GETTING_STARTED_STEP_LABEL,
  STOCK_PREP_GETTING_STARTED_STEP_ORDER,
  stockPrepBlockerNeedsDeploymentData,
  stockPrepGettingStartedEvidence,
  stockPrepGettingStartedProgress,
  stockPrepGettingStartedSteps,
  type StockPrepGettingStartedBinding,
  type StockPrepGettingStartedStepKey,
} from '../../../services/integration/stockPreparation/gettingStarted'
import {
  readStockPrepDataSourceRegistry,
  stockPrepDataSourceRegistryUnknown,
  type StockPrepDataSourceRegistry,
} from '../../../services/integration/stockPreparation/dataSourceRegistry'
import {
  readStockPrepOnboardingReadiness,
  stockPrepOnboardingReadinessUnknown,
  type StockPrepOnboardingReadiness,
} from '../../../services/integration/stockPreparation/onboardingReadiness'
import {
  stockPrepBlockerPlain,
  stockPrepPermissionPlain,
} from '../../../services/integration/stockPreparation/plainLanguage'
import { STOCK_PREPARATION_LEGACY_BRIDGE_KIND } from '../../../services/integration/stockPreparation/sourceBinding'

const props = defineProps<{
  defaults: StockPreparationInstallDefaults | null
  preflight: StockPreparationPreflight | null
  /** The DEPLOYMENT-PREFLIGHT read's own status slot — not the page-wide error banner's. */
  preflightErrorStatus: number | null
  sourcePreflight: StockPrepSourcePreflight | null
  sourcePreflightErrorStatus: number | null
  /** The source-binding panel's server answer, `null` when this page has none (→「? 看不到」). */
  binding: StockPrepGettingStartedBinding | null
  report: StockPreparationInstallRunReport | null
  canRunInstall: boolean
  busy: boolean
  /**
   * P1-1 — whether THIS component carries step ②'s run control (see the install view's
   * `wizardSourceCheckControl`). Optional and defaulting to `'none'`, so every existing caller and
   * every spec that mounts this component directly renders byte-for-byte what it did before.
   */
  sourceCheckControl?: 'none' | 'run' | 'denied'
  /**
   * 整合切片 (2026-09-09) — whether this reader can actually OPEN 数据工厂, i.e. whether they
   * pass the workbench route's own `integration:write` gate. The host resolves it through the
   * shared `useAuth().hasPermission`, the same probe the router guard uses, so the link and the
   * guard cannot drift.
   *
   * Optional and DEFAULTING TO FALSE (fail closed — Vue casts an absent Boolean prop to false):
   * a host that forgets to pass it renders the 「找实施」 sentence, never a link that the guard
   * bounces. It grants nothing either way: this prop decides what step ① SAYS, and the server's
   * own /api/data-sources gate decides what anyone can do there.
   */
  canOpenDataFactory?: boolean
}>()

const emit = defineEmits<{
  (event: 'run-preflight-check'): void
  /** ② 证明它只能读 — the host owns the read; this component owns only the button. */
  (event: 'run-source-preflight'): void
  (event: 'run-install'): void
  (event: 'navigate-stage', viewKey: string): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const stepOrder = STOCK_PREP_GETTING_STARTED_STEP_ORDER

function stepLabel(key: StockPrepGettingStartedStepKey) {
  return STOCK_PREP_GETTING_STARTED_STEP_LABEL[key]
}

// ---------------------------------------------------------------------------
// ⑤「谁能用」— the live role-catalog check (P1-3)
// ---------------------------------------------------------------------------

/** `null` until the first read settles — the FIRST-PAINT state, rendered as 「正在看…」, not as a verdict. */
const accessReadiness = ref<StockPrepOnboardingReadiness | null>(null)
const accessChecking = ref(false)
/**
 * Monotonic sequence + an unmount latch (#3365「卸载即作废」). A 「重新检查」 pressed while an earlier
 * read is still out must not be overwritten by that earlier read landing second, and neither read may
 * write into a component that is already gone.
 */
let accessSeq = 0
let accessDisposed = false
/** The in-flight soft-timeout timer, cancelled on unmount alongside the copy timers (#3365). */
let accessTimeoutTimer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  accessDisposed = true
  if (accessTimeoutTimer) clearTimeout(accessTimeoutTimer)
  accessTimeoutTimer = null
})

/**
 * The soft timeout. A request that neither resolves nor rejects — a hung proxy, a connection the OS
 * never tears down — would otherwise leave this card stuck on 「正在看…」 with 「重新检查」 disabled
 * forever, i.e. a page with no second way out. At the deadline the card falls to the same
 * 「? 看不到」 it uses for every other unanswered read; the in-flight request is simply ignored if it
 * ever lands late (the sequence latch below already handles that).
 */
const ACCESS_READ_TIMEOUT_MS = 15000

async function checkAccessReadiness(): Promise<void> {
  const seq = accessSeq + 1
  accessSeq = seq
  accessChecking.value = true
  if (accessTimeoutTimer) clearTimeout(accessTimeoutTimer)
  const deadline = new Promise<StockPrepOnboardingReadiness>((resolve) => {
    accessTimeoutTimer = setTimeout(() => resolve(stockPrepOnboardingReadinessUnknown(null)), ACCESS_READ_TIMEOUT_MS)
  })
  let answer: StockPrepOnboardingReadiness
  try {
    answer = await Promise.race([readStockPrepOnboardingReadiness(), deadline])
  } catch {
    // The service is documented never to reject; this is the belt to that braces, so a future change
    // there can never turn this fire-and-forget call into an unhandled rejection.
    answer = stockPrepOnboardingReadinessUnknown(null)
  } finally {
    if (accessTimeoutTimer) clearTimeout(accessTimeoutTimer)
    accessTimeoutTimer = null
  }
  if (accessDisposed || seq !== accessSeq) return
  accessReadiness.value = answer
  accessChecking.value = false
}

// Runs on mount, before any button on this page has been pressed — the wizard's whole point is that
// it tells you where the deployment stands without being asked.
onMounted(() => { void checkAccessReadiness() })

const accessStateKey = computed<string>(() => accessReadiness.value?.state ?? 'checking')
const accessRoles = computed(() => accessReadiness.value?.roles ?? [])
const accessRoleOverflow = computed(() => Math.max(0, (accessReadiness.value?.roleCount ?? 0) - accessRoles.value.length))
/** Only warn about double counting when it is actually possible — i.e. more than one qualifying role. */
const accessDoubleCounted = computed(() => (accessReadiness.value?.roleCount ?? 0) > 1)

interface AccessVerdictText {
  glyph: string
  tone: 'success' | 'warning' | 'muted'
  zh: string
  en: string
  /** The 「下一步该做什么」 line, or empty when the state needs none. */
  nextZh: string
  nextEn: string
}

/**
 * THE FOUR VERDICTS, and the words for each. Note what is NOT here: 「没完成」/「还没开始」. A role
 * catalog this account cannot read says nothing about whether the work was done, and a deployment
 * that has been serving the floor for a year would have been labelled 「还没开始」 every single time.
 */
const accessVerdict = computed<AccessVerdictText>(() => {
  const readiness = accessReadiness.value
  if (readiness === null) {
    return {
      glyph: '⋯',
      tone: 'muted',
      zh: '正在看现在有没有这样的角色…',
      en: 'Checking whether such a role exists…',
      nextZh: '',
      nextEn: '',
    }
  }
  if (readiness.state === 'ready') {
    return {
      glyph: '✔',
      tone: 'success',
      // 验收 4's own wording. Scoped on purpose: it reports the two things the catalog answers, and
      // the 「还有一件本页看不到的事」 line right below it names the third.
      zh: `有 ${readiness.roleCount} 个角色能让一线满足备料的权限要求,成员共 ${readiness.memberTotal} 人。`,
      en: `${readiness.roleCount} role(s) satisfy the stock-prep access requirement for the floor, with ${readiness.memberTotal} member(s) between them.`,
      // NOT 「这些人应该已经能打开了」. That was a sufficiency promise the gate does not back: the
      // per-user 「插件使用」 admission is a third condition this read cannot see (module header of
      // onboardingReadiness.ts), and an administrator who trusted the promise would ship a floor
      // that opens 备料 to a flat 403.
      nextZh: '这两件事本页看得到,第三件看不到(见下面那条)。最靠谱的确认方式:让其中一位一线用自己的账号真的打开一次备料工作台。',
      nextEn: 'This page can see those two things; it cannot see the third (see the line below). The reliable confirmation is to have one of those people actually open the workbench with their own account.',
    }
  }
  if (readiness.state === 'no_members') {
    return {
      glyph: '⚠',
      tone: 'warning',
      zh: `有 ${readiness.roleCount} 个角色能让一线满足备料的权限要求,但里面一个人都还没有。`,
      en: `${readiness.roleCount} role(s) satisfy the requirement, but nobody has been put in them yet.`,
      nextZh: '下一步:到「用户管理」把要用备料的人放进这个角色,再在同一个人的「插件使用」里把 stock-prep 开通。角色本身不用再动。',
      nextEn: 'Next: add the people who need stock-prep to that role under User Management, then enable stock-prep under the same person\'s "Plugin access". The role itself needs no further change.',
    }
  }
  if (readiness.state === 'no_role') {
    return {
      glyph: '⚠',
      tone: 'warning',
      zh: '还没有任何角色同时持有这两个权限码(持有 stock-prep:admin 的角色也算,同样没有)。',
      en: 'No role holds both codes yet (a role holding stock-prep:admin would also count — there is none).',
      nextZh: '怎么建,三件事:① 到「角色管理」新建一个角色(或挑一个现成的),把 stock-prep:read 和 stock-prep:operate 两个都勾上并保存 —— 两个要勾在同一个角色上;② 到「用户管理」把人放进这个角色;③ 在同一个人的「插件使用」里把 stock-prep 开通。三件都做完才生效。',
      nextEn: 'How to set it up, three things: (1) in Role Management create a role (or pick an existing one) and tick BOTH stock-prep:read and stock-prep:operate on it — both on the same role; (2) add people to that role under User Management; (3) enable stock-prep under the same person\'s "Plugin access". All three are needed.',
    }
  }
  // 「看不到」 SPLIT BY STATUS. The service collapses 403/401/404/500/502/network/HTML/unknown-shape
  // into one state on purpose (G4), but the WORDS cannot collapse with it: telling a platform
  // administrator that they lack permission because the server returned 500 is a causal claim this
  // page cannot back, and it points them at the wrong next move (see onboardingReadiness.ts's
  // `status`, which is carried precisely so this sentence can fork).
  if (readiness.status === 401 || readiness.status === 403) {
    return {
      glyph: '?',
      tone: 'muted',
      zh: '看不到 —— 当前账号读不到平台的角色目录,所以这一步是不是做好了,本页判断不了。',
      en: 'Cannot tell — this account cannot read the platform role catalog, so this page cannot judge whether this step is done.',
      nextZh: '这不代表没配。读角色目录要平台管理员;请平台管理员确认,或者用下面的「复制一份待办」把这件事交出去。',
      nextEn: 'That does not mean it is unconfigured. Reading the catalog needs a platform administrator — ask one to confirm, or hand the task off with the copy button below.',
    }
  }
  return {
    glyph: '?',
    tone: 'muted',
    zh: '看不到 —— 这次没读到平台的角色目录,所以这一步是不是做好了,本页判断不了。',
    en: 'Cannot tell — the platform role catalog could not be read this time, so this page cannot judge whether this step is done.',
    nextZh: '这不代表没配。可能是网络或服务端,也可能是当前账号没有读角色目录的权限。可以点「重新检查」再试一次;还是不行就用下面的「复制一份待办」交给平台管理员。',
    nextEn: 'That does not mean it is unconfigured. It may be the network or the server, or this account may not be allowed to read the catalog. Press "Check again", and if it still will not answer, hand it off with the copy button below.',
  }
})

/**
 * 线框 B2's second row, restated to match the gate.
 *
 * The wireframe's own gloss — 「能看安装页(只读);建表仍是平台管理员」 — describes the SMALLEST
 * thing `stock-prep:admin` does, and reading it as the whole thing is dangerous in the unsafe
 * direction: `satisfiesStockPrepAccess` returns true for that code BEFORE it looks at read/operate
 * (`stock-preparation-workbench-access.cjs`), so holding it means the queue, the confirm button and
 * the export as well. An administrator who took it for a read-only observer badge would hand out
 * full operate. It is therefore counted like any other qualifying role, and described as what it is.
 */
const accessAdminNote = computed<{ zh: string; en: string } | null>(() => {
  const readiness = accessReadiness.value
  if (readiness === null || readiness.state === 'unknown') return null
  return readiness.adminRoleCount > 0
    ? {
      zh: `上面这些角色里,有 ${readiness.adminRoleCount} 个是靠 stock-prep:admin 满足的 —— 这一码在备料里同时满足 read 和 operate(三码里最大的一个),持有它的人能开队列、能逐条确认、能导出,不只是看安装页。`,
      en: `${readiness.adminRoleCount} of the roles above qualify through stock-prep:admin — that code satisfies both read and operate here (the largest of the three), so its holders can open the queue, confirm and export, not merely view the install page.`,
    }
    : {
      zh: '没有角色持有 stock-prep:admin。一线用 read + operate 就够,不必配它;要配也请当成最大的那一码来配 —— 它同时满足 read 和 operate,不是「只能看安装页」。',
      en: 'No role holds stock-prep:admin. The floor needs only read + operate, so it is not required; if you do grant it, treat it as the largest of the three — it satisfies both read and operate, it is not a view-only install-page badge.',
    }
})

/**
 * The roles that satisfy the gate through its PLATFORM-ADMIN short-circuit (`role:admin` from the
 * role id, or the `integration:admin` code). Kept out of the verdict — every deployment has one from
 * the moment it is installed, and counting it would let this step read ✔ on a host where no one on
 * the floor can open anything — but said out loud, because they are real holders.
 */
const accessPlatformAdminNote = computed<{ zh: string; en: string } | null>(() => {
  const readiness = accessReadiness.value
  if (readiness === null || readiness.state === 'unknown' || readiness.platformAdminRoleCount < 1) return null
  return {
    zh: `另外有 ${readiness.platformAdminRoleCount} 个平台管理员档的角色,里面的人本来就能打开备料 —— 上面的判定没有把他们算进去,因为他们不是一线。`,
    en: `${readiness.platformAdminRoleCount} platform-administrator role(s) exist as well, and their members can already open stock-prep — the verdict above excludes them, because they are not the floor.`,
  }
})

// ---------------------------------------------------------------------------
// ①a「登记外接数据源」— the second live read (向导①拆分, 2026-09-10)
//
// WHY A READ AND NOT A DERIVATION. The source-binding envelope this page already holds enumerates
// external SYSTEMS, so it is SILENT about whether a data source is registered: a deployment can hold
// a working SQL Server and simply not have wired a binding to it yet. Deriving ①a from that silence
// would report 「还没登记」 to an administrator who registered one an hour ago — see
// `dataSourceRegistry.ts`'s header for the whole argument.
//
// D6 IS UNTOUCHED: that rule is about probing the CUSTOMER's database, and this reads our own
// in-process adapter list. G3 too — the service never rejects and collapses every unanswerable
// outcome into `unknown`, so a refusal becomes a badge, never a banner and never a redirect.
// ---------------------------------------------------------------------------

/** `null` until the first read settles — the FIRST-PAINT state, rendered 「? 看不到」, not a verdict. */
const dataSourceRegistry = ref<StockPrepDataSourceRegistry | null>(null)

/**
 * Fire-and-forget on mount. NO soft timeout and NO sequence latch, deliberately, because neither has
 * anything to guard here: this read has no 「重新检查」 button, so there is never a second one in
 * flight to be overtaken, and a request that never settles simply leaves ①a at its honest
 * first-paint 「? 看不到」 rather than stranding a disabled control (the two reasons ⑤ needs both).
 * The unmount latch IS shared — #3365「卸载即作废」 applies to every callback a view schedules.
 */
async function loadDataSourceRegistry(): Promise<void> {
  let answer: StockPrepDataSourceRegistry
  try {
    answer = await readStockPrepDataSourceRegistry()
  } catch {
    // The service is documented never to reject; this is the belt to that braces, so a future change
    // there can never turn this fire-and-forget call into an unhandled rejection.
    answer = stockPrepDataSourceRegistryUnknown(null)
  }
  if (accessDisposed) return
  dataSourceRegistry.value = answer
}

onMounted(() => { void loadDataSourceRegistry() })

const derivationInput = computed(() => ({
  preflight: props.preflight,
  preflightErrorStatus: props.preflightErrorStatus,
  sourcePreflight: props.sourcePreflight,
  sourcePreflightErrorStatus: props.sourcePreflightErrorStatus,
  binding: props.binding,
  // The service's own verdict plus one integer. Nothing here re-decides anything, and no connection
  // NAME exists in this projection to be rendered by accident.
  dataSourceRegistry: dataSourceRegistry.value
    ? {
        state: dataSourceRegistry.value.state,
        sqlCount: dataSourceRegistry.value.sqlCount,
        // The status rides along ONLY so a 401/403 can name the missing permission. No other
        // status produces a sentence, and no count or name is added by carrying it.
        status: dataSourceRegistry.value.status,
      }
    : null,
  roleReadiness: accessReadiness.value?.state ?? null,
}))

/**
 * F06 — is this deployment wired for the bridge that carries its own connection details?
 *
 * Read off the ACTION's own frozen kind, which the source-binding envelope already resolved
 * (`effectiveSourceKind`); nothing here re-derives it. `false` while the envelope has not arrived,
 * which is the right default: the ①a/①b instructions are what this page shows by default, and a
 * page that suppressed them on a guess would hide the only two steps most deployments need.
 */
const isLegacyBridgeDeployment = computed(
  () => props.binding?.requiredKind === STOCK_PREPARATION_LEGACY_BRIDGE_KIND,
)

const steps = computed(() => stockPrepGettingStartedSteps(derivationInput.value))
const progress = computed(() => stockPrepGettingStartedProgress(steps.value))

function badgeOf(key: StockPrepGettingStartedStepKey) {
  return STOCK_PREP_GETTING_STARTED_BADGE[steps.value[key]]
}

function evidenceOf(key: StockPrepGettingStartedStepKey) {
  return stockPrepGettingStartedEvidence(key, derivationInput.value)
}

const preflightBlockers = computed<StockPreparationPreflightBlocker[]>(() =>
  Array.isArray(props.preflight?.blockers) ? (props.preflight!.blockers as StockPreparationPreflightBlocker[]) : [])

function blockerKind(blocker: StockPreparationPreflightBlocker): 'http' | 'env' {
  return stockPrepBlockerNeedsDeploymentData(blocker) ? 'env' : 'http'
}

const blockerPlain = stockPrepBlockerPlain
const permissionPlain = stockPrepPermissionPlain

/** The three permission codes §14's own defaults panel already lists — restated here, not retyped. */
const accessCodes = computed<string[]>(() => {
  const fromManifest = props.defaults?.permissions.codes
  return Array.isArray(fromManifest) && fromManifest.length > 0
    ? fromManifest
    : ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']
})

/**
 * The five `driven: false` steps and the four driven ones, straight off the shared descriptor table.
 * Counted rather than typed, so a step that changes sides in `installRun.ts` changes here with it.
 */
const heldPlanRows = computed(() => STOCK_PREPARATION_INSTALL_STEPS.filter((descriptor) => !descriptor.driven))
const heldCount = computed(() => heldPlanRows.value.length)
const drivenCount = computed(() => STOCK_PREPARATION_INSTALL_STEPS.length - heldPlanRows.value.length)

/**
 * How many steps still need a person AFTER a passing run. A run's SKIPs are exactly those steps, so
 * the report's own count is used when there is one; before/without a report the structural count is
 * the honest answer. This is the number the hand-off card quotes instead of claiming a trial run.
 */
const outstandingSteps = computed(() => (
  typeof props.report?.skipCount === 'number' && props.report.skipCount > 0 ? props.report.skipCount : heldCount.value
))

const showCompletion = computed(() => props.report?.pass === true)

/**
 * What the hand-off card is allowed to say about WHO can open the address it is about to hand over.
 * Straight off step⑤'s live answer — the two cards used to be able to say opposite things on one
 * screen (⑤:「还没有任何角色…」 / card:「把地址发给他们」), and the confident one was the false one.
 */
const handoffReadiness = computed<{ zh: string; en: string }>(() => {
  const readiness = accessReadiness.value
  const state = readiness?.state ?? null
  if (state === 'ready') {
    return {
      zh: `第⑤步现在看到:有 ${readiness!.roleCount} 个角色能让一线满足权限要求,成员共 ${readiness!.memberTotal} 人。还有每个人的「插件使用」要开通 stock-prep,那一步本页看不到 —— 先让一位一线打开一次确认,再群发。`,
      en: `Step ⑤ currently reads: ${readiness!.roleCount} qualifying role(s) with ${readiness!.memberTotal} member(s). Each person still needs stock-prep enabled under "Plugin access", which this page cannot see — have one of them open it once before you send this to everyone.`,
    }
  }
  if (state === 'no_role' || state === 'no_members') {
    return {
      zh: '先别急着群发:第⑤步现在看到的是权限还没配齐(上面第⑤步写了差哪一步)。现在发过去,他们打开会是没权限。',
      en: 'Hold off on sending this out: step ⑤ currently reads that access is not set up yet (it says which part is missing). If you send it now, they will be refused when they open it.',
    }
  }
  return {
    zh: '发之前先确认谁能用:第⑤步这个账号看不到,本页判断不了权限配没配好。',
    en: 'Before you send it, confirm who can use it: this account cannot read step ⑤\'s answer, so this page cannot judge whether access is set up.',
  }
})

// ---------------------------------------------------------------------------
// Copy buttons — every payload below is authored/constant text plus, at most, a clamped blocker
// CODE. Nothing interpolates a server message, a project number or a material value (values-free).
// ---------------------------------------------------------------------------

type CopyLabelState = 'copy' | 'copied'

/** Every timer this component schedules, cancelled on unmount (#3365「卸载即作废」). */
const copyResetTimers = new Set<ReturnType<typeof setTimeout>>()
onBeforeUnmount(() => {
  for (const timer of copyResetTimers) clearTimeout(timer)
  copyResetTimers.clear()
})

function makeCopyState() {
  const state = ref<CopyLabelState>('copy')
  let timer: ReturnType<typeof setTimeout> | null = null
  async function run(text: string): Promise<void> {
    // `copyTextToClipboard`'s own fallback path calls `document.execCommand`, which some hosts (and
    // this project's jsdom test environment) do not implement at all rather than answering `false` —
    // caught here so an environment without ANY copy mechanism degrades to "nothing happened" instead
    // of an unhandled rejection out of a fire-and-forget click handler.
    let ok = false
    try {
      ok = await copyTextToClipboard(text)
    } catch {
      ok = false
    }
    if (ok) {
      state.value = 'copied'
      if (timer) {
        clearTimeout(timer)
        copyResetTimers.delete(timer)
      }
      timer = setTimeout(() => {
        state.value = 'copy'
        if (timer) copyResetTimers.delete(timer)
      }, 3000)
      copyResetTimers.add(timer)
    }
  }
  return { state, run }
}

const blockerCopy = makeCopyState()
const blockerCopyLabel = blockerCopy.state
/**
 * I-9: an `env` blocker's payload carries the route's OWN `fix.run` line VERBATIM. That line is the
 * thing the person on the deployment machine actually executes, and rewriting it is rewriting the
 * fix — the same discipline the disclosure further down this page already applies to it. It is a
 * server-authored deployment instruction (an env var name and a path shape), never response data
 * about a customer's rows, so it stays values-free.
 */
function copyBlockerForOps(blocker: StockPreparationPreflightBlocker): void {
  const plain = blockerPlain(blocker.code)
  const sentence = plain ? bi(plain.zhNext || plain.zh, plain.enNext || plain.en) : blocker.what
  const run = blocker.fix?.run
  void blockerCopy.run(run ? `${blocker.code} — ${sentence}\n${run}` : `${blocker.code} — ${sentence}`)
}

const installTodoCopy = makeCopyState()
const installTodoCopyLabel = installTodoCopy.state
/**
 * 线框 F's hand-off payload. It names WHICH blockers are outstanding (by code + the committed
 * sentence for that code), because "第 4 步卡住了" alone makes the recipient re-run the check the
 * sender just ran. Codes and committed prose only — never `blocker.what`, which is server text.
 */
function copyInstallTodo(): void {
  const lines = preflightBlockers.value.map((blocker) => {
    const plain = blockerPlain(blocker.code)
    return plain ? `· ${blocker.code} — ${bi(plain.zh, plain.en)}` : `· ${blocker.code}`
  })
  // THE ROUTE IN THIS SENTENCE IS A PLACE ON A SCREEN, so it moves when the screen does. P1-1 gave
  // 开始使用 its own rail item, which means it is no longer 「『数据来源与体检』最上面的那一段」 — an
  // administrator following the old wording would land on a page with no wizard on it. Asserted in
  // StockPreparationGettingStarted.spec.ts so the next move of this view reddens a test rather than
  // a chat message somebody already pasted.
  const head = bi(
    '备料工作台第 4 步(建表 + 装列)还没过。请平台管理员打开备料工作台 → 左栏「开始使用」→ 第④步 → 点「开始安装」。重复运行是安全的。',
    'Stock-prep step 4 (create tables and install columns) has not passed. Please have a platform administrator open the stock-preparation workbench → "Getting started" in the left rail → step ④ → press "Start install". Running it again is safe.',
  )
  const detail = lines.length > 0
    ? `\n${bi('还差这些:', 'Outstanding:')}\n${lines.join('\n')}`
    : ''
  void installTodoCopy.run(`${head}${detail}`)
}

const accessTodoCopy = makeCopyState()
const accessTodoCopyLabel = accessTodoCopy.state
/**
 * THREE steps, not two. The role and the membership are the two this page can check; the per-user
 * 「插件使用」 admission is the one it cannot, and it is the one that is missed by default — adding
 * an EXISTING user to a role writes no admission row, so a to-do that stopped at step two would be
 * followed to the letter and still leave the floor at 403.
 */
function copyAccessTodo(): void {
  void accessTodoCopy.run(bi(
    '请帮备料工作台配一下权限,三件事:① 在「角色管理」创建或确认一个角色,同时持有 stock-prep:read 与 stock-prep:operate(两个勾在同一个角色上;已有持 stock-prep:admin 的角色也可以,那一码同时满足这两项);② 在「用户管理」把要用它的人放进这个角色;③ 在同一个人的「插件使用」里把 stock-prep 开通 —— 把已有的人加进角色不会自动开通,漏了第三步他们打开备料还是没权限。',
    'Please set up permissions for the stock-prep workbench — three things: (1) in Role Management create or confirm one role holding both stock-prep:read and stock-prep:operate (both on the same role; an existing role holding stock-prep:admin also works, as that code satisfies both); (2) in User Management add the people who need it to that role; (3) enable stock-prep under the same person\'s "Plugin access" — adding an existing user to a role does not enable it automatically, and without step 3 they are still refused.',
  ))
}

const linkCopy = makeCopyState()
const linkCopyLabel = linkCopy.state
function copyWorkbenchLink(): void {
  void linkCopy.run(`${window.location.origin}/stock-prep`)
}

const handoffCopy = makeCopyState()
const handoffCopyLabel = handoffCopy.state
/**
 * THE ONE PAYLOAD THAT LEAVES THIS SYSTEM. It gets pasted into a customer group chat, so every
 * sentence has to survive being read by someone who cannot check it against the page.
 * It therefore does NOT name a landing tab — which tab a person lands on depends on their own
 * permissions (`landsOnStockPrepProjectBoard`: read+operate → 项目备料页; read-only → 确认队列), and
 * an earlier cut asserted 「进去直接是确认队列」 for everyone, which is wrong for exactly the audience
 * this message is addressed to. It also does not claim the deployment "装好了" — this component
 * cannot know that a project has ever run through it.
 */
function copyHandoffMessage(): void {
  // THE LEAD SENTENCE IS THE CLAIM, so it follows step⑤ rather than `report.pass`. 「可以用了」 is a
  // statement about the READER's access, which `pass` (= the install run had no failure) does not
  // support on its own; sending it while no role qualifies is a promise the page can already see is
  // false. The rest of the message — the five steps and the 「打不开就找管理员」 tail — is identical
  // either way, because it is true either way.
  const ready = accessReadiness.value?.state === 'ready'
  const zhLead = ready
    ? '备料工作台可以用了:用自己的账号打开 /stock-prep。'
    : '备料工作台请先试着打开一次:用自己的账号打开 /stock-prep。'
  const enLead = ready
    ? 'The stock-prep workbench is ready to use: open /stock-prep with your own account.'
    : 'Please try opening the stock-prep workbench once: open /stock-prep with your own account.'
  void handoffCopy.run(bi(
    `${zhLead}用法:找到您的项目 → 从 PLM 拉进来 → 有拿不准的就逐条拿主意 → 回来再同步一次 → 导出 Excel。打不开或看不到项目,说明权限还没配到您头上,找管理员。`,
    `${enLead} How to use it: find your project → pull it in from PLM → decide anything the system is unsure about → sync once more → export to Excel. If it will not open, or shows no projects, your account has not been granted access yet — ask an administrator.`,
  ))
}
</script>

<style scoped>
.stock-prep-gs {
  margin: 0 0 var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.stock-prep-gs__title {
  margin: 0 0 var(--ms-space-2);
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.stock-prep-gs__intro {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  line-height: 1.6;
}

.stock-prep-gs__map {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  margin: 0 0 var(--ms-space-3);
  padding: 0;
  list-style: none;
}

.stock-prep-gs__step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  font-size: 13px;
}

/* 现在的情况 (线框 B2). A bordered block rather than a colour wash: three of the four verdicts are
   deliberately NOT green, and a tinted panel would have to pick a background for 「看不到」 that says
   something the state does not. */
/* 线框 B2's 「现在的情况」 heading — the probe block used to sit label-less directly under the ⓘ
   conjunction sentence, which read as a continuation of it rather than as a live reading. */
.stock-prep-gs__probe-label {
  margin: 0 0 6px;
  color: var(--ms-text-2);
  font-weight: 600;
}

.stock-prep-gs__probe {
  margin: 0 0 var(--ms-space-2);
  padding: var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
}

.stock-prep-gs__probe-headline {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0 0 6px;
  color: var(--ms-text-1);
  line-height: 1.6;
}

.stock-prep-gs__glyph--success { color: var(--ms-color-success); }
.stock-prep-gs__glyph--info { color: var(--ms-color-info); }
.stock-prep-gs__glyph--warning { color: var(--ms-color-warning); }
.stock-prep-gs__glyph--danger { color: var(--ms-color-danger); }
.stock-prep-gs__glyph--muted { color: var(--ms-text-3); }

.stock-prep-gs__badge {
  font-size: 12px;
  color: var(--ms-text-3);
}

.stock-prep-gs__badge--success { color: var(--ms-color-success); }
.stock-prep-gs__badge--info { color: var(--ms-color-info); }
.stock-prep-gs__badge--warning { color: var(--ms-color-warning); }
.stock-prep-gs__badge--danger { color: var(--ms-color-danger); }

.stock-prep-gs__card {
  margin: 0 0 var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.stock-prep-gs__card--complete {
  border-color: var(--ms-color-success);
}

.stock-prep-gs__h4 {
  margin: 0 0 var(--ms-space-2);
  font-size: 14px;
  color: var(--ms-text-1);
}

.stock-prep-gs__hint {
  margin: 4px 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-gs__list {
  margin: 0;
  padding-left: var(--ms-space-4);
}

.stock-prep-gs__list--plain {
  list-style: none;
  padding-left: 0;
}

.stock-prep-gs__blocker {
  margin-bottom: var(--ms-space-2);
}

.stock-prep-gs__blocker-action {
  display: block;
  margin-top: 4px;
}

.stock-prep-gs__token {
  margin-left: 6px;
  font-size: 12px;
  color: var(--ms-text-3);
}

.stock-prep-gs__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  align-items: center;
  margin-top: var(--ms-space-2);
}

.stock-prep-gs__plan {
  margin: 0;
  padding-left: var(--ms-space-4);
}

.stock-prep-gs__plan-row {
  margin-bottom: 4px;
  font-size: 13px;
}

/* G1 —— 每屏一个主操作位. Exactly ONE filled `--ms-color-primary` button exists per rendering of this
   wizard: 「开始安装」 when the reader can run it, otherwise 「复制一份待办给平台管理员」, which is
   that reader's one real action. Everything else is a plain bordered button or a text link.
   (The four per-step run-status colours that used to sit here went with the duplicated nine-step
   list: status is rendered once, by the install panel further down this page.) */
.stock-prep-gs__button {
  padding: 4px 12px;
  border: 1px solid var(--ms-border);
  border-radius: 4px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
}

.stock-prep-gs__button:disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.stock-prep-gs__button--primary {
  border-color: var(--ms-color-primary);
  background: var(--ms-color-primary);
  color: #fff;
}

.stock-prep-gs__progress {
  margin-left: var(--ms-space-2);
  font-size: 13px;
  font-weight: normal;
  color: var(--ms-text-2);
}

.stock-prep-gs__evidence {
  color: var(--ms-text-2);
}

.stock-prep-gs__h5 {
  margin: var(--ms-space-2) 0 var(--ms-space-1);
  font-size: 13px;
  color: var(--ms-text-2);
}
</style>
