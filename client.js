/**
 * Client half of dsh-date-sync: a global sidebar panel that shows the sync
 * state and edits the connection settings through the Host's JSON endpoints.
 *
 * Plain JavaScript, no build step: React comes from the browser module table,
 * styles use only `--dsw-alias-*` theme tokens, and every visible string is
 * routed through the Client locale service.
 */
window.__ModuleLoader__.load({
  id: 'dsh-date-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'date-sync'
    const API = 'api/date-sync'

    const ZH = {
      panelLabel: '数据同步',
      title: '数据同步',
      subtitle: '通过 WebDAV 让技能、MCP、模型配置、插件与会话在多台电脑之间保持一致。',
      configTitle: '连接配置',
      provider: '同步协议',
      webdav: 'WebDAV',
      s3: 'S3 对象存储',
      endpoint: 'S3 Endpoint',
      endpointHint: '例如 https://s3.example.com:9000（MinIO 或兼容 S3 的服务）',
      bucket: 'Bucket',
      bucketHint: '存储桶名称',
      region: 'Region',
      regionHint: 'MinIO 一般填 us-east-1',
      accessKey: 'Access Key',
      secretKey: 'Secret Key',
      keyPrefix: '对象前缀',
      keyPrefixHint: 'bucket 内的路径前缀，默认 dsh-sync',
      url: 'WebDAV 地址',
      urlHint: '例如 https://dav.example.com/remote.php/dav/files/me/harness',
      username: '用户名',
      password: '密码',
      passwordStored: '已保存密码，留空则不修改',
      passwordEmpty: '可选；留空则使用环境变量',
      passwordEnv: '密码 / 密钥环境变量',
      passwordEnvHint: '优先使用该环境变量，避免密码写入任何文件',
      clearPassword: '清除已保存的密码 / 密钥',
      remoteRoot: '远程根目录',
      remoteRootHint: 'WebDAV 上的子目录，默认 dsh-sync',
      pollInterval: '拉取间隔（秒）',
      pollHint: '远端改动最快在一个周期后出现',
      conflictPolicy: '冲突策略',
      newestWins: '较新者胜（推荐）',
      localWins: '本机优先',
      remoteWins: '远端优先',
      deletions: '删除策略',
      propagate: '传播删除',
      restore: '恢复删除',
      watch: '监听本机改动（实时推送）',
      scopes: '同步范围',
      scopeSkills: '技能 skills',
      scopeAgentSkills: '共享 Agent 技能',
      scopeSessions: '会话记录',
      scopeProfile: 'MCP / 模型 / 插件配置',
      scopeCredentials: '凭据文件（明文，谨慎）',
      save: '保存',
      saving: '应用中…',
      saved: '已保存并重新启动同步引擎',
      saveFailed: '保存失败',
      syncNow: '立即同步',
      pause: '暂停',
      resume: '恢复',
      statusTitle: '同步状态',
      notConfigured: '未配置',
      ready: '运行中',
      syncing: '同步中',
      paused: '已暂停',
      attention: '需要注意',
      lastSync: '最近同步',
      never: '尚未同步',
      uploaded: '已上传',
      downloaded: '已下载',
      conflicts: '冲突',
      failed: '失败',
      tracked: '跟踪',
      files: '个文件',
      remoteTarget: '远程位置',
      localScopes: '本机范围',
      recent: '最近活动',
      noActivity: '暂无同步记录',
      warnings: '提示',
      missingBundles: '以下插件包在本机未安装',
      linkDeps: '以下依赖使用了本机路径，不能跨机复用',
      configError: '配置错误',
      loadFailed: '读取状态失败',
      retry: '重试',
      configFile: '配置文件',
      stateDir: '状态目录',
      conflictCopies: '冲突备份',
      copies: '份',
      credentialsNote: '凭据文件会以明文上传到 WebDAV，仅在可信服务器上开启。',
      advanced: '高级',
      basic: '基本',
      activityEmpty: '同步引擎会在这里记录上传、下载、冲突和错误。',
      loading: '载入中…',
      logs: '日志',
      hide: '收起',
      notConfiguredHint: '填写连接信息并保存后开始同步',
      dirty: '有未保存的修改',
    }

    const EN = {
      panelLabel: 'Data Sync',
      title: 'Data Sync',
      subtitle: 'Keep skills, MCP servers, model settings, plugins, and sessions consistent across computers through WebDAV.',
      configTitle: 'Connection',
      provider: 'Protocol',
      webdav: 'WebDAV',
      s3: 'S3 object storage',
      endpoint: 'S3 endpoint',
      endpointHint: 'For example https://s3.example.com:9000 (MinIO or S3-compatible)',
      bucket: 'Bucket',
      bucketHint: 'Bucket name',
      region: 'Region',
      regionHint: 'MinIO usually accepts us-east-1',
      accessKey: 'Access key',
      secretKey: 'Secret key',
      keyPrefix: 'Object prefix',
      keyPrefixHint: 'Path prefix inside the bucket, default dsh-sync',
      url: 'WebDAV URL',
      urlHint: 'For example https://dav.example.com/remote.php/dav/files/me/harness',
      username: 'Username',
      password: 'Password',
      passwordStored: 'A password is saved; leave blank to keep it',
      passwordEmpty: 'Optional; leave blank to use the environment variable',
      passwordEnv: 'Password / secret environment variable',
      passwordEnvHint: 'Takes precedence and keeps the password out of every file',
      clearPassword: 'Clear the saved password / secret key',
      remoteRoot: 'Remote root folder',
      remoteRootHint: 'Subfolder on the WebDAV server, default dsh-sync',
      pollInterval: 'Pull interval (seconds)',
      pollHint: 'Remote changes appear after at most one interval',
      conflictPolicy: 'Conflict policy',
      newestWins: 'Newest wins (recommended)',
      localWins: 'Local wins',
      remoteWins: 'Remote wins',
      deletions: 'Deletion policy',
      propagate: 'Propagate deletions',
      restore: 'Restore deletions',
      watch: 'Watch local changes (instant push)',
      scopes: 'Scopes',
      scopeSkills: 'Skills',
      scopeAgentSkills: 'Shared agent skills',
      scopeSessions: 'Sessions',
      scopeProfile: 'MCP / models / plugin config',
      scopeCredentials: 'Credential file (plaintext, careful)',
      save: 'Save',
      saving: 'Applying…',
      saved: 'Saved and restarted the sync engine',
      saveFailed: 'Save failed',
      syncNow: 'Sync now',
      pause: 'Pause',
      resume: 'Resume',
      statusTitle: 'Status',
      notConfigured: 'Not configured',
      ready: 'Running',
      syncing: 'Syncing',
      paused: 'Paused',
      attention: 'Needs attention',
      lastSync: 'Last sync',
      never: 'Never',
      uploaded: 'Uploaded',
      downloaded: 'Downloaded',
      conflicts: 'Conflicts',
      failed: 'Failed',
      tracked: 'tracked',
      files: 'files',
      remoteTarget: 'Remote target',
      localScopes: 'Local scopes',
      recent: 'Recent activity',
      noActivity: 'No sync activity yet',
      warnings: 'Notes',
      missingBundles: 'These plugin packages are not installed here',
      linkDeps: 'These dependencies use a local path and cannot be shared',
      configError: 'Configuration error',
      loadFailed: 'Could not read status',
      retry: 'Retry',
      configFile: 'Config file',
      stateDir: 'State directory',
      conflictCopies: 'Conflict copies',
      copies: 'copies',
      credentialsNote: 'The credential file is uploaded in plaintext; enable this only on a trusted server.',
      advanced: 'Advanced',
      basic: 'Basics',
      activityEmpty: 'Uploads, downloads, conflicts, and errors will appear here.',
      loading: 'Loading…',
      logs: 'Log',
      hide: 'Hide',
      notConfiguredHint: 'Fill in the connection and save to start',
      dirty: 'Unsaved changes',
    }

    const CSS = `
      .dws-page { height: 100%; overflow: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .dws-wrap { max-width: 720px; margin: 0 auto; padding: 32px 24px 64px; box-sizing: border-box; }
      .dws-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
      .dws-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .dws-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
      .dws-actions { display: flex; gap: 8px; flex: none; }
      .dws-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 12px; line-height: 1.4; cursor: pointer; white-space: nowrap; }
      .dws-btn:hover:not(:disabled) { background: var(--dsw-alias-button-floating-hover); }
      .dws-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dws-btn:disabled { opacity: 0.45; cursor: default; }
      .dws-btn.primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
      .dws-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .dws-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
      .dws-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dws-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
      .dws-pill.ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
      .dws-pill.busy { color: var(--dsw-alias-brand-primary); border-color: currentColor; }
      .dws-pill.warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
      .dws-pill.error { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
      .dws-pill.idle { color: var(--dsw-alias-state-idle-primary); }
      .dws-segmented { display: inline-flex; gap: 3px; padding: 3px; border-radius: 9px; background: var(--dsw-alias-interactive-bg-hover); }
      .dws-segment { appearance: none; border: 0; border-radius: 7px; padding: 5px 12px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
      .dws-segment[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .dws-segment:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dws-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
      .dws-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .dws-field.wide { grid-column: 1 / -1; }
      .dws-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dws-input { box-sizing: border-box; width: 100%; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
      .dws-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 0; border-color: transparent; }
      .dws-save-cell { display: flex; align-items: flex-end; justify-content: flex-end; }
      .dws-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 0 4px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dws-counts { display: flex; gap: 10px; font-variant-numeric: tabular-nums; }
      .dws-warn-text { color: var(--dsw-alias-state-warn-primary); }
      .dws-error-text { color: var(--dsw-alias-state-error-primary); }
      .dws-links { margin-left: auto; display: flex; gap: 12px; }
      .dws-link { appearance: none; border: 0; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 0; cursor: pointer; }
      .dws-link:hover { color: var(--dsw-alias-label-primary); }
      .dws-link:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .dws-error { margin: 0 0 12px; padding: 0 4px; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dws-ok { margin: 0 0 12px; padding: 0 4px; font-size: 12px; color: var(--dsw-alias-state-success-primary); }
      .dws-muted { margin: 0; padding: 0 4px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); word-break: break-word; }
      .dws-scopes { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
      .dws-scope { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .dws-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; font-size: 12px; }
      .dws-spacer { flex: 1; }
      .dws-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 34px; height: 19px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; transition: background-color 0.12s ease; }
      .dws-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
      .dws-switch:disabled { cursor: default; opacity: 0.5; }
      .dws-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .dws-switch-thumb { display: block; width: 15px; height: 15px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 0.12s ease, background-color 0.12s ease; }
      .dws-switch[aria-checked="true"] .dws-switch-thumb { transform: translateX(15px); background: var(--dsw-alias-label-primary-foreground); }
      .dws-log { display: flex; flex-direction: column; }
      .dws-log-row { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; align-items: baseline; }
      .dws-log-row:last-child { border-bottom: none; }
      .dws-log-time { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .dws-log-text { min-width: 0; word-break: break-word; }
      .dws-log-row.warn .dws-log-text { color: var(--dsw-alias-state-warn-primary); }
      .dws-log-row.error .dws-log-text { color: var(--dsw-alias-state-error-primary); }
      @media (max-width: 640px) {
        .dws-wrap { padding: 20px 16px 56px; }
        .dws-grid { grid-template-columns: 1fr; }
        .dws-head { flex-wrap: wrap; }
      }
    `

    function errorText(error) {
      if (!error) return 'unknown error'
      return error.message ? String(error.message) : String(error)
    }

    async function requestJson(path, options) {
      const response = await fetch(`${API}/${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: {
          ...(options && options.body ? { 'content-type': 'application/json' } : {}),
          ...(options && options.headers ? options.headers : {}),
        },
      })
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : undefined
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        const failure = new Error(message)
        failure.payload = payload
        throw failure
      }
      return payload
    }

    function useTranslator(ctx) {
      const [, bump] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => ctx.locale.subscribe(() => bump()), [ctx])
      return React.useMemo(() => ctx.locale.bind(NS), [ctx])
    }

    function formatTime(value, locale) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    }

    function clockTime(value) {
      if (!value) return '--:--:--'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '--:--:--'
      return date.toLocaleTimeString(undefined, { hour12: false })
    }

    /** Host-style switch: 36×20 track, 16px thumb, token-driven colors. */
    function Switch({ checked, onChange, label, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        className: 'dws-switch',
        disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'dws-switch-thumb' }))
    }

    /**
     * Green when the last cycle reached the server, red when it could not, grey
     * while unconfigured or paused. A success older than three poll intervals
     * (and at least a minute) also counts as lost connectivity.
     */
    function badgeState(status) {
      if (!status) return 'idle'
      if (status.paused) return 'idle'
      if (!status.configured) return 'error'
      if (status.connection === 'error') return 'error'
      if (status.connection === 'ok') {
        const interval = Number(status.pollIntervalMs) || 15000
        const allowed = Math.max(interval * 3, 60_000)
        const last = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : Number.NaN
        if (!Number.isFinite(last)) return 'ok'
        return Date.now() - last > allowed ? 'error' : 'ok'
      }
      return 'idle'
    }

    function PanelIcon({ size = 20, ctx }) {
      const [badge, setBadge] = React.useState('idle')

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            const status = await requestJson('status')
            if (alive) setBadge(badgeState(status))
          } catch {
            if (alive) setBadge('error')
          }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, 5000)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void tick()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { d: 'M7.2 18.2h9.3a3.9 3.9 0 0 0 .6-7.76 5.6 5.6 0 0 0-10.82-1.4A3.6 3.6 0 0 0 7.2 18.2Z' }),
        h('path', { d: 'M9.1 11.2h4.4' }),
        h('path', { d: 'm11.8 9.6 1.7 1.6-1.7 1.6' }),
        h('path', { d: 'M14.9 15.4h-3.4' }),
        h('path', { d: 'm13 13.9-1.6 1.5 1.6 1.5' }),
        badge === 'idle'
          ? null
          : h('circle', {
              cx: 19.4,
              cy: 4.6,
              r: 3.1,
              fill: badge === 'ok'
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-error-primary)',
              stroke: 'var(--dsw-alias-bg-base)',
              strokeWidth: 1.3,
            }),
      )
    }

    function Panel({ ctx }) {
      const t = useTranslator(ctx)
      const locale = ctx.locale.getLocale().active
      const [status, setStatus] = React.useState(undefined)
      const [statusError, setStatusError] = React.useState('')
      const [config, setConfig] = React.useState(undefined)
      const [form, setForm] = React.useState(undefined)
      const [formError, setFormError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [showAdvanced, setShowAdvanced] = React.useState(false)
      const [showLog, setShowLog] = React.useState(false)
      const alive = React.useRef(true)
      const formRef = React.useRef(undefined)
      formRef.current = form

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const applyConfigPayload = React.useCallback((payload) => {
        setConfig(payload)
        setForm({
          provider: payload.provider === 's3' ? 's3' : 'webdav',
          url: payload.url ?? '',
          bucket: payload.bucket ?? '',
          region: payload.region ?? 'us-east-1',
          username: payload.username ?? '',
          password: '',
          clearPassword: false,
          remoteRoot: payload.remoteRoot ?? 'dsh-sync',
          pollSeconds: String(Math.max(1, Math.round((payload.pollIntervalMs ?? 15000) / 1000))),
          conflictPolicy: payload.conflictPolicy ?? 'newest-wins',
          deletions: payload.deletions ?? 'propagate',
          watch: payload.watch !== false,
          scopes: payload.scopes ?? {},
          passwordEnv: payload.passwordEnv ?? '',
        })
      }, [])

      React.useEffect(() => {
        let cancelled = false
        const tick = async () => {
          try {
            const payload = await requestJson('status')
            if (!alive.current || cancelled) return
            setStatus(payload)
            setStatusError('')
          } catch (error) {
            if (!alive.current || cancelled) return
            setStatusError(errorText(error))
          }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, 2500)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        requestJson('config')
          .then((payload) => {
            if (!cancelled) applyConfigPayload(payload)
          })
          .catch((error) => {
            if (!cancelled) setFormError(errorText(error))
          })
        return () => {
          cancelled = true
        }
      }, [applyConfigPayload])

      const patch = (next) => {
        setForm((current) => (current ? { ...current, ...next } : current))
        setNotice('')
      }
      const patchScope = (key, value) => {
        setForm((current) => (current ? { ...current, scopes: { ...current.scopes, [key]: value } } : current))
        setNotice('')
      }

      const save = async () => {
        const current = formRef.current
        if (!current) return
        setBusy('save')
        setFormError('')
        setNotice('')
        try {
          const payload = {
            provider: current.provider,
            url: current.url,
            bucket: current.bucket,
            region: current.region,
            username: current.username,
            remoteRoot: current.remoteRoot,
            pollIntervalMs: Math.round(Number(current.pollSeconds || '0') * 1000),
            conflictPolicy: current.conflictPolicy,
            deletions: current.deletions,
            watch: current.watch,
            scopes: current.scopes,
            passwordEnv: current.passwordEnv,
            clearPassword: current.clearPassword === true,
          }
          if (current.password) payload.password = current.password
          const result = await requestJson('config', { method: 'POST', body: JSON.stringify(payload) })
          if (result && result.config) applyConfigPayload(result.config)
          if (result && result.status) setStatus(result.status)
          setNotice(t('saved'))
        } catch (error) {
          setFormError(errorText(error))
        } finally {
          setBusy('')
        }
      }

      const act = async (action) => {
        setBusy(action)
        setFormError('')
        setNotice('')
        try {
          const result = await requestJson('action', { method: 'POST', body: JSON.stringify({ action }) })
          if (result && result.status) setStatus(result.status)
        } catch (error) {
          setFormError(errorText(error))
        } finally {
          setBusy('')
        }
      }

      const render = status && typeof status === 'object' ? status : undefined
      const configured = Boolean(render && render.configured)
      const paused = Boolean(render && render.paused)
      const syncing = Boolean(render && render.syncing)
      const hasError = Boolean(render && render.lastError)
      let pillClass = 'idle'
      let pillLabel = t('notConfigured')
      if (render && render.configError) {
        pillClass = 'error'
        pillLabel = t('configError')
      } else if (configured && paused) {
        pillClass = 'warn'
        pillLabel = t('paused')
      } else if (configured && syncing) {
        pillClass = 'busy'
        pillLabel = t('syncing')
      } else if (configured) {
        pillClass = hasError ? 'warn' : 'ok'
        pillLabel = hasError ? t('attention') : t('ready')
      }

      const counts = (render && render.counts) || {}
      const scopes = (render && Array.isArray(render.scopes)) ? render.scopes : []
      const recent = (render && Array.isArray(render.recent)) ? render.recent.slice(-14).reverse() : []
      const warnings = []
      if (render) {
        if (render.configError) warnings.push(render.configError)
        if (render.configFileError) warnings.push(`${t('configFile')}: ${render.configFileError}`)
        if (render.lastError) warnings.push(render.lastError)
        for (const warning of Array.isArray(render.warnings) ? render.warnings : []) warnings.push(warning)
        if (Array.isArray(render.missingBundles) && render.missingBundles.length > 0) {
          warnings.push(`${t('missingBundles')}: ${render.missingBundles.join(', ')}`)
        }
        if (Array.isArray(render.localLinkDependencies) && render.localLinkDependencies.length > 0) {
          warnings.push(`${t('linkDeps')}: ${render.localLinkDependencies.map((item) => item.name).join(', ')}`)
        }
      }

      const isS3 = form && form.provider === 's3'
      const errorLine = render ? (render.configError || render.connectionError || render.lastError || '') : ''
      const scopeLabels = {
        skills: t('scopeSkills'),
        agentSkills: t('scopeAgentSkills'),
        sessions: t('scopeSessions'),
        profile: t('scopeProfile'),
        credentials: t('scopeCredentials'),
      }

      return h('div', { className: 'dws-page' },
        h('style', null, CSS),
        h('div', { className: 'dws-wrap' },
          h('header', { className: 'dws-head' },
            h('div', { className: 'dws-heading' },
              h('h1', { className: 'dws-title' }, t('title')),
              h('span', { className: `dws-pill ${pillClass}` }, h('span', { className: 'dws-dot' }), pillLabel),
            ),
            h('div', { className: 'dws-actions' },
              h('button', {
                type: 'button',
                className: 'dws-btn',
                disabled: !configured || Boolean(busy),
                onClick: () => { void act('sync') },
              }, busy === 'sync' ? t('syncing') : t('syncNow')),
              h('button', {
                type: 'button',
                className: 'dws-btn',
                disabled: !configured || Boolean(busy),
                onClick: () => { void act(paused ? 'resume' : 'pause') },
              }, paused ? t('resume') : t('pause')),
            ),
          ),

          statusError && !render ? h('p', { className: 'dws-error' }, statusError) : null,

          h('section', { className: 'dws-card' },
            form
              ? h('div', null,
                  h('div', { className: 'dws-segmented' },
                    ['webdav', 's3'].map((provider) => h('button', {
                      key: provider,
                      type: 'button',
                      className: 'dws-segment',
                      'aria-pressed': form.provider === provider,
                      onClick: () => patch({ provider }),
                    }, t(provider))),
                  ),
                  h('div', { className: 'dws-grid' },
                    h('label', { className: 'dws-field wide' },
                      h('span', { className: 'dws-label' }, t(isS3 ? 'endpoint' : 'url')),
                      h('input', {
                        className: 'dws-input',
                        type: 'url',
                        spellCheck: false,
                        placeholder: isS3 ? 'https://s3.example.com:9000' : 'https://dav.example.com/dav',
                        value: form.url,
                        onChange: (event) => patch({ url: event.target.value }),
                      }),
                    ),
                    isS3
                      ? h('label', { className: 'dws-field' },
                          h('span', { className: 'dws-label' }, t('bucket')),
                          h('input', {
                            className: 'dws-input',
                            type: 'text',
                            spellCheck: false,
                            value: form.bucket,
                            onChange: (event) => patch({ bucket: event.target.value }),
                          }),
                        )
                      : null,
                    isS3
                      ? h('label', { className: 'dws-field' },
                          h('span', { className: 'dws-label' }, t('region')),
                          h('input', {
                            className: 'dws-input',
                            type: 'text',
                            spellCheck: false,
                            value: form.region,
                            onChange: (event) => patch({ region: event.target.value }),
                          }),
                        )
                      : null,
                    h('label', { className: 'dws-field' },
                      h('span', { className: 'dws-label' }, t(isS3 ? 'accessKey' : 'username')),
                      h('input', {
                        className: 'dws-input',
                        type: 'text',
                        autoComplete: 'username',
                        value: form.username,
                        onChange: (event) => patch({ username: event.target.value }),
                      }),
                    ),
                    h('label', { className: 'dws-field' },
                      h('span', { className: 'dws-label' }, t(isS3 ? 'secretKey' : 'password')),
                      h('input', {
                        className: 'dws-input',
                        type: 'password',
                        autoComplete: 'new-password',
                        placeholder: config && config.hasPassword ? t('passwordStored') : '',
                        value: form.password,
                        onChange: (event) => patch({ password: event.target.value, clearPassword: false }),
                      }),
                    ),
                    h('label', { className: 'dws-field' },
                      h('span', { className: 'dws-label' }, t(isS3 ? 'keyPrefix' : 'remoteRoot')),
                      h('input', {
                        className: 'dws-input',
                        type: 'text',
                        spellCheck: false,
                        value: form.remoteRoot,
                        onChange: (event) => patch({ remoteRoot: event.target.value }),
                      }),
                    ),
                    h('div', { className: 'dws-save-cell' },
                      h('button', {
                        type: 'button',
                        className: 'dws-btn primary',
                        disabled: Boolean(busy),
                        onClick: () => { void save() },
                      }, busy === 'save' ? t('saving') : t('save')),
                    ),
                  ),
                )
              : h('p', { className: 'dws-muted' }, statusError || t('loading')),
          ),

          h('section', { className: 'dws-summary' },
            configured
              ? h('span', null, `${t('lastSync')} · ${formatTime(render && render.lastSyncAt, locale)}`)
              : null,
            configured
              ? h('span', { className: 'dws-counts' },
                  h('span', { title: t('uploaded') }, `↑${counts.uploaded ?? 0}`),
                  h('span', { title: t('downloaded') }, `↓${counts.downloaded ?? 0}`),
                  h('span', { title: t('conflicts'), className: counts.conflicts ? 'dws-warn-text' : '' }, `⇄${counts.conflicts ?? 0}`),
                  h('span', { title: t('failed'), className: counts.failed ? 'dws-error-text' : '' }, `!${counts.failed ?? 0}`),
                )
              : null,
            h('span', { className: 'dws-links' },
              h('button', { type: 'button', className: 'dws-link', onClick: () => setShowAdvanced((value) => !value) }, showAdvanced ? t('hide') : t('advanced')),
              h('button', { type: 'button', className: 'dws-link', onClick: () => setShowLog((value) => !value) }, showLog ? t('hide') : t('logs')),
            ),
          ),

          errorLine ? h('p', { className: 'dws-error', title: errorLine }, errorLine) : null,
          !errorLine && render && !configured ? h('p', { className: 'dws-muted' }, t('notConfiguredHint')) : null,
          formError ? h('p', { className: 'dws-error' }, formError) : null,
          notice ? h('p', { className: 'dws-ok' }, notice) : null,

          showAdvanced && form
            ? h('section', { className: 'dws-card' },
                h('div', { className: 'dws-grid' },
                  h('label', { className: 'dws-field' },
                    h('span', { className: 'dws-label' }, t('pollInterval')),
                    h('input', {
                      className: 'dws-input',
                      type: 'number',
                      min: 1,
                      max: 86400,
                      value: form.pollSeconds,
                      onChange: (event) => patch({ pollSeconds: event.target.value }),
                    }),
                  ),
                  h('label', { className: 'dws-field' },
                    h('span', { className: 'dws-label' }, t('conflictPolicy')),
                    h('select', {
                      className: 'dws-input',
                      value: form.conflictPolicy,
                      onChange: (event) => patch({ conflictPolicy: event.target.value }),
                    },
                      h('option', { value: 'newest-wins' }, t('newestWins')),
                      h('option', { value: 'local-wins' }, t('localWins')),
                      h('option', { value: 'remote-wins' }, t('remoteWins')),
                    ),
                  ),
                  h('label', { className: 'dws-field' },
                    h('span', { className: 'dws-label' }, t('deletions')),
                    h('select', {
                      className: 'dws-input',
                      value: form.deletions,
                      onChange: (event) => patch({ deletions: event.target.value }),
                    },
                      h('option', { value: 'propagate' }, t('propagate')),
                      h('option', { value: 'restore' }, t('restore')),
                    ),
                  ),
                  h('label', { className: 'dws-field' },
                    h('span', { className: 'dws-label' }, t('passwordEnv')),
                    h('input', {
                      className: 'dws-input',
                      type: 'text',
                      spellCheck: false,
                      value: form.passwordEnv,
                      onChange: (event) => patch({ passwordEnv: event.target.value }),
                    }),
                  ),
                ),
                h('div', { className: 'dws-inline' },
                  h(Switch, {
                    checked: form.watch !== false,
                    onChange: (value) => patch({ watch: value }),
                    label: t('watch'),
                  }),
                  h('span', null, t('watch')),
                  h('span', { className: 'dws-spacer' }),
                  h(Switch, {
                    checked: form.clearPassword === true,
                    onChange: (value) => patch({ clearPassword: value, password: '' }),
                    label: t('clearPassword'),
                  }),
                  h('span', null, t('clearPassword')),
                ),
                h('div', { className: 'dws-scopes' },
                  Object.keys(scopeLabels).map((key) => h('div', { key, className: 'dws-scope' },
                    h(Switch, {
                      checked: form.scopes[key] !== false && (key !== 'credentials' || form.scopes[key] === true),
                      onChange: (value) => patchScope(key, value),
                      label: scopeLabels[key],
                    }),
                    h('span', null, scopeLabels[key]),
                  )),
                ),
                form.scopes.credentials === true
                  ? h('p', { className: 'dws-muted', style: { marginTop: 10 } }, t('credentialsNote'))
                  : null,
                warnings.length > 0
                  ? h('div', { className: 'dws-muted', style: { marginTop: 10 } }, warnings.map((warning, index) => h('div', { key: index }, warning)))
                  : null,
                render && render.configFile
                  ? h('div', { className: 'dws-muted', style: { marginTop: 10 } }, render.configFile)
                  : null,
              )
            : null,

          showLog
            ? h('section', { className: 'dws-card' },
                recent.length === 0
                  ? h('p', { className: 'dws-muted' }, t('activityEmpty'))
                  : h('div', { className: 'dws-log' },
                      recent.slice(0, 8).map((entry, index) => h('div', {
                        key: `${entry.at}-${index}`,
                        className: `dws-log-row ${entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : ''}`,
                      },
                        h('span', { className: 'dws-log-time' }, clockTime(entry.at)),
                        h('span', { className: 'dws-log-text' }, entry.message ?? ''),
                      )),
                    ),
              )
            : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A live module replacement can apply the new generation before the
        // previous one has released the locale namespace. The dictionaries are
        // identical, so a duplicate registration must not abort the slots.
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'date-sync: dictionaries')
        } catch {
          // Another generation still owns the namespace; slot registration below
          // remains the important part.
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'date-sync',
          order: 6,
          locale: NS,
          label: () => ctx.locale.bind(NS)('panelLabel'),
        }, (props) => h(PanelIcon, { ...props, ctx })))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'date-sync',
          locale: NS,
        }, (props) => h(Panel, { ...props, ctx })))
      },
    }
  },
})
