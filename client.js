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
      url: 'WebDAV 地址',
      urlHint: '例如 https://dav.example.com/remote.php/dav/files/me/harness',
      username: '用户名',
      password: '密码',
      passwordStored: '已保存密码，留空则不修改',
      passwordEmpty: '可选；留空则使用环境变量',
      passwordEnv: '密码环境变量',
      passwordEnvHint: '优先使用该环境变量，避免密码写入任何文件',
      clearPassword: '清除面板保存的密码',
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
      save: '保存并应用',
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
      dirty: '有未保存的修改',
    }

    const EN = {
      panelLabel: 'Data Sync',
      title: 'Data Sync',
      subtitle: 'Keep skills, MCP servers, model settings, plugins, and sessions consistent across computers through WebDAV.',
      configTitle: 'Connection',
      url: 'WebDAV URL',
      urlHint: 'For example https://dav.example.com/remote.php/dav/files/me/harness',
      username: 'Username',
      password: 'Password',
      passwordStored: 'A password is saved; leave blank to keep it',
      passwordEmpty: 'Optional; leave blank to use the environment variable',
      passwordEnv: 'Password environment variable',
      passwordEnvHint: 'Takes precedence and keeps the password out of every file',
      clearPassword: 'Clear the panel-saved password',
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
      save: 'Save and apply',
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
      dirty: 'Unsaved changes',
    }

    const CSS = `
      .dws-page { height: 100%; overflow: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .dws-wrap { max-width: 940px; margin: 0 auto; padding: 28px 28px 72px; box-sizing: border-box; }
      .dws-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
      .dws-title { margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
      .dws-sub { margin: 0; max-width: 560px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
      .dws-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
      .dws-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 7px 14px; font: inherit; font-size: 13px; line-height: 1.35; cursor: pointer; white-space: nowrap; }
      .dws-btn:hover:not(:disabled) { background: var(--dsw-alias-button-floating-hover); }
      .dws-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .dws-btn:disabled { opacity: 0.45; cursor: default; }
      .dws-btn.primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
      .dws-btn.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .dws-card { margin-bottom: 14px; padding: 18px 20px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
      .dws-card h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; font-size: 14px; font-weight: 600; }
      .dws-card h2 .dws-card-note { font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dws-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dws-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
      .dws-pill.ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
      .dws-pill.busy { color: var(--dsw-alias-brand-primary); border-color: currentColor; }
      .dws-pill.warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
      .dws-pill.error { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
      .dws-pill.idle { color: var(--dsw-alias-state-idle-primary); }
      .dws-banner { display: flex; gap: 10px; margin-bottom: 14px; padding: 11px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
      .dws-banner.error { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
      .dws-banner.warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
      .dws-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(224px, 1fr)); gap: 14px; }
      .dws-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .dws-field.wide { grid-column: 1 / -1; }
      .dws-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dws-input { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
      .dws-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; border-color: transparent; }
      .dws-hint { font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .dws-inline { display: flex; align-items: center; gap: 10px; font-size: 13px; }
      .dws-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; transition: background-color 0.12s ease; }
      .dws-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
      .dws-switch:disabled { cursor: default; opacity: 0.5; }
      .dws-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .dws-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 0.12s ease, background-color 0.12s ease; }
      .dws-switch[aria-checked="true"] .dws-switch-thumb { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground); }
      .dws-scopes { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; margin-top: 16px; }
      .dws-scope { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
      .dws-scope .dws-switch { margin-top: 1px; }
      .dws-scope-body { min-width: 0; }
      .dws-scope-name { font-size: 13px; font-weight: 500; }
      .dws-scope-path { margin-top: 2px; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .dws-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); gap: 10px; }
      .dws-stat { padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
      .dws-stat b { display: block; font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .dws-stat span { display: block; margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dws-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 14px; }
      .dws-meta-row { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .dws-meta-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dws-meta-value { font-size: 12px; line-height: 1.45; word-break: break-all; }
      .dws-log { display: flex; flex-direction: column; max-height: 300px; overflow: auto; }
      .dws-log-row { display: grid; grid-template-columns: 62px 52px minmax(0, 1fr); gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
      .dws-log-row:last-child { border-bottom: none; }
      .dws-log-time { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .dws-log-level { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .dws-log-level.warn { color: var(--dsw-alias-state-warn-primary); }
      .dws-log-level.error { color: var(--dsw-alias-state-error-primary); }
      .dws-log-text { min-width: 0; word-break: break-word; }
      .dws-empty { padding: 8px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dws-save-row { grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 4px; }
      .dws-save-note { margin-right: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dws-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
      .dws-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }
      @media (max-width: 720px) {
        .dws-wrap { padding: 20px 16px 56px; }
        .dws-head { flex-direction: column; }
        .dws-actions { justify-content: flex-start; }
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
          url: payload.url ?? '',
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
            url: current.url,
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
            h('div', null,
              h('h1', { className: 'dws-title' }, t('title')),
              h('p', { className: 'dws-sub' }, t('subtitle')),
            ),
            h('div', { className: 'dws-actions' },
              h('span', { className: `dws-pill ${pillClass}` }, h('span', { className: 'dws-dot' }), pillLabel),
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

          statusError && !render
            ? h('div', { className: 'dws-banner error' }, `${t('loadFailed')}: ${statusError}`)
            : null,
          render && !configured && !render.configError
            ? h('div', { className: 'dws-banner' }, t('subtitle'))
            : null,
          formError ? h('div', { className: 'dws-banner error' }, formError) : null,
          notice ? h('div', { className: 'dws-banner' }, notice) : null,

          h('section', { className: 'dws-card' },
            h('h2', null, t('configTitle')),
            form
              ? h('div', { className: 'dws-form' },
                  h('label', { className: 'dws-field wide' },
                    h('span', { className: 'dws-label' }, t('url')),
                    h('input', {
                      className: 'dws-input',
                      type: 'url',
                      spellCheck: false,
                      placeholder: 'https://dav.example.com/remote.php/dav/files/me/harness',
                      value: form.url,
                      onChange: (event) => patch({ url: event.target.value }),
                    }),
                    h('span', { className: 'dws-hint' }, t('urlHint')),
                  ),
                  h('label', { className: 'dws-field' },
                    h('span', { className: 'dws-label' }, t('username')),
                    h('input', {
                      className: 'dws-input',
                      type: 'text',
                      autoComplete: 'username',
                      value: form.username,
                      onChange: (event) => patch({ username: event.target.value }),
                    }),
                  ),
                  h('label', { className: 'dws-field' },
                    h('span', { className: 'dws-label' }, t('password')),
                    h('input', {
                      className: 'dws-input',
                      type: 'password',
                      autoComplete: 'new-password',
                      placeholder: config && config.hasPassword ? t('passwordStored') : t('passwordEmpty'),
                      value: form.password,
                      onChange: (event) => patch({ password: event.target.value, clearPassword: false }),
                    }),
                    h('div', { className: 'dws-inline' },
                      h(Switch, {
                        checked: form.clearPassword === true,
                        onChange: (value) => patch({ clearPassword: value, password: '' }),
                        label: t('clearPassword'),
                      }),
                      h('span', null, t('clearPassword')),
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
                    h('span', { className: 'dws-hint' }, t('passwordEnvHint')),
                  ),
                  h('label', { className: 'dws-field' },
                    h('span', { className: 'dws-label' }, t('remoteRoot')),
                    h('input', {
                      className: 'dws-input',
                      type: 'text',
                      spellCheck: false,
                      value: form.remoteRoot,
                      onChange: (event) => patch({ remoteRoot: event.target.value }),
                    }),
                    h('span', { className: 'dws-hint' }, t('remoteRootHint')),
                  ),
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
                    h('span', { className: 'dws-hint' }, t('pollHint')),
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
                  h('div', { className: 'dws-field wide' },
                    h('div', { className: 'dws-inline' },
                      h(Switch, {
                        checked: form.watch !== false,
                        onChange: (value) => patch({ watch: value }),
                        label: t('watch'),
                      }),
                      h('span', null, t('watch')),
                    ),
                  ),
                  h('div', { className: 'dws-field wide' },
                    h('span', { className: 'dws-label' }, t('scopes')),
                    h('div', { className: 'dws-scopes' },
                      Object.keys(scopeLabels).map((key) => {
                        const scope = scopes.find((item) => item.key === key)
                        return h('div', { key, className: 'dws-scope' },
                          h(Switch, {
                            checked: form.scopes[key] !== false && (key !== 'credentials' || form.scopes[key] === true),
                            onChange: (value) => patchScope(key, value),
                            label: scopeLabels[key],
                          }),
                          h('span', { className: 'dws-scope-body' },
                            h('span', { className: 'dws-scope-name' }, scopeLabels[key]),
                            scope && scope.local
                              ? h('span', { className: 'dws-scope-path' }, `${scope.local} · ${scope.trackedFiles ?? 0} ${t('files')}`)
                              : null,
                          ),
                        )
                      }),
                    ),
                    form.scopes.credentials === true
                      ? h('span', { className: 'dws-hint' }, t('credentialsNote'))
                      : null,
                  ),
                  h('div', { className: 'dws-save-row' },
                    h('span', { className: 'dws-save-note' }, busy === 'save' ? t('saving') : ''),
                    h('button', {
                      type: 'button',
                      className: 'dws-btn primary',
                      disabled: Boolean(busy),
                      onClick: () => { void save() },
                    }, busy === 'save' ? t('saving') : t('save')),
                  ),
                )
              : h('div', { className: 'dws-empty' }, statusError || t('loadFailed')),
          ),

          h('section', { className: 'dws-card' },
            h('h2', null, t('statusTitle'),
              render && render.profileName ? h('span', { className: 'dws-card-note' }, `· ${render.profileName}`) : null,
            ),
            h('div', { className: 'dws-stats' },
              stat(h, t('uploaded'), counts.uploaded),
              stat(h, t('downloaded'), counts.downloaded),
              stat(h, t('conflicts'), counts.conflicts),
              stat(h, t('failed'), counts.failed),
              stat(h, t('tracked'), (render && render.scopes ? render.scopes.reduce((sum, item) => sum + (item.trackedFiles ?? 0), 0) : 0)),
            ),
            h('div', { className: 'dws-meta' },
              meta(h, t('lastSync'), formatTime(render && render.lastSyncAt, locale)),
              meta(h, t('remoteTarget'), render && render.remote ? `${render.remote.url || '—'} / ${render.remote.root || '—'}` : '—'),
              meta(h, t('configFile'), render && render.configFile ? render.configFile : '—', true),
              meta(h, t('conflictCopies'), `${(render && render.conflictsOnDisk) ?? 0} ${t('copies')}`),
            ),
          ),

          h('section', { className: 'dws-card' },
            h('h2', null, t('localScopes')),
            scopes.length === 0
              ? h('div', { className: 'dws-empty' }, t('noActivity'))
              : h('div', { className: 'dws-form' },
                  scopes.map((scope) => h('div', { key: scope.key, className: 'dws-scope' },
                    h('span', { className: 'dws-dot', style: { marginTop: 6, color: scope.localExists ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' } }),
                    h('span', { className: 'dws-scope-body' },
                      h('span', { className: 'dws-scope-name' }, scopeLabels[scope.key] ?? scope.key),
                      h('span', { className: 'dws-scope-path' }, `${scope.local} → ${scope.remote}`),
                      h('span', { className: 'dws-scope-path' }, `${scope.trackedFiles ?? 0} ${t('tracked')}`),
                    ),
                  )),
                ),
          ),

          warnings.length > 0
            ? h('section', { className: 'dws-card' },
                h('h2', null, t('warnings')),
                h('ul', { className: 'dws-list' }, warnings.map((warning, index) => h('li', { key: index }, warning))),
              )
            : null,

          h('section', { className: 'dws-card' },
            h('h2', null, t('recent')),
            recent.length === 0
              ? h('div', { className: 'dws-empty' }, render ? t('activityEmpty') : t('noActivity'))
              : h('div', { className: 'dws-log' },
                  recent.map((entry, index) => h('div', { key: `${entry.at}-${index}`, className: 'dws-log-row' },
                    h('span', { className: 'dws-log-time' }, clockTime(entry.at)),
                    h('span', { className: `dws-log-level ${entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : ''}` }, entry.level ?? 'info'),
                    h('span', { className: 'dws-log-text' }, entry.message ?? ''),
                  )),
                ),
          ),
        ),
      )
    }

    function stat(h, label, value) {
      return h('div', { className: 'dws-stat' },
        h('b', null, String(value ?? 0)),
        h('span', null, label),
      )
    }

    function meta(h, label, value, code) {
      return h('div', { className: 'dws-meta-row' },
        h('span', { className: 'dws-meta-label' }, label),
        h('span', { className: `dws-meta-value${code ? ' dws-code' : ''}` }, value ?? '—'),
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
