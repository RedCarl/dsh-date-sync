# dsh-date-sync

通过 **WebDAV** 或 **S3 兼容对象存储**（MinIO、RustFS、AWS S3 等），把多台电脑上的 DeepSeek Harness 环境保持一致：**技能（skills）、MCP 服务器、模型配置、插件开关与配置、会话记录**。左侧栏提供独立面板，用于查看状态、手动同步和修改连接配置。

插件是纯 Node 实现：没有 npm 依赖，只用 `fetch` 和 Node 内置模块，适合以本地目录（`link:`）方式安装。

## 同步内容

| 作用域 | 本地路径 | 远端路径 | 默认 |
|---|---|---|---|
| `skills` | `$DSH_HOME/skills` | `<remoteRoot>/skills/…` | 开 |
| `agentSkills` | `~/.agents/skills`（或 `$DSH_AGENTS_HOME/skills`） | `<remoteRoot>/agents-skills/…` | 开 |
| `sessions` | `$DSH_HOME/sessions` | `<remoteRoot>/sessions/…` | 开 |
| `profile` | `$DSH_PROFILE_DIR/cordis.patch.yml`、`package.json` | `<remoteRoot>/profile/…` | 开 |
| `credentials` | `$DSH_HOME/.credentials.yaml` | `<remoteRoot>/credentials/…` | 关 |

MCP 服务器、模型（provider/model）和插件开关都写在 profile 的 `cordis.patch.yml` / `package.json` 里，所以 `profile` 作用域会把它们一起同步。插件包本身（`node_modules`）不通过网络传输：每台机器仍需在本地安装一次包，详见下文。

## 实时性

- **本机改动 → 远端**：文件监听（`fs.watch`，递归）在 0.8 秒防抖后立即推送，通常 1 秒内完成。
- **远端 → 本机**：WebDAV 没有推送协议，插件按 `pollIntervalMs`（默认 15 秒，最小 1 秒）做一次增量 PROPFIND。想让其他机器的改动更快出现，可以调小它。
- **正在使用的会话不会被覆盖**：如果某个会话在本机是打开状态，只跳过**下载**（避免远端版本覆盖正在追加的日志）；上传会在最后一次写入后静默 `settleMs` 再执行，保证压缩帧完整。
- **写入是原子的**：下载先写同目录临时文件再 `rename`，Harness 的文件监听和 HMR 不会读到半个文件。profile patch 被替换后，HMR 会自动重载配置。
- **轮询是按需增量的**：每轮用 PROPFIND 只取目录元数据，内容哈希只对“mtime/大小变了”的文件计算。

## 存储后端

面板顶部的「同步协议」可以切换两种后端：

### WebDAV（默认）

Nextcloud、群晖、Alist/OpenList、Apache mod_dav、rclone serve webdav 等。配置 `url` + `username` + `password`。

### S3 兼容对象存储

MinIO、RustFS、AWS S3、Cloudflare R2 等。配置 `url`（endpoint）+ `bucket` + `region` + Access Key + Secret Key：

```yaml
provider: s3
url: 'https://s3.example.com'        # endpoint，不要带 bucket
bucket: 'dsh-sync'
region: 'us-east-1'                  # MinIO/RustFS 通常填 us-east-1
username: 'ACCESS_KEY'               # Access Key
password: 'SECRET_KEY'               # Secret Key
remoteRoot: 'dsh-sync'               # bucket 内的对象前缀
```

需要该凭据对 bucket 具备 **ListBucket / GetObject / PutObject / DeleteObject** 权限。对象按扁平 key 存储：`<remoteRoot>/skills/...`、`<remoteRoot>/sessions/...`。默认使用 path-style（`https://endpoint/bucket/key`），适用于 IP/自建域名；AWS 这类虚拟主机风格可设 `pathStyle: false`。

S3 的 `If-Match` / `If-None-Match` 条件写入用于防止并发覆盖；服务端不支持时会退回普通写入。

## 安装

不需要 npm 账号，直接从 GitHub 仓库安装：

```bash
dsh plugin --profile web add https://github.com/RedCarl/dsh-date-sync
```

也可以在 DSH 的「设置 → 插件」里粘贴上面的 GitHub 地址，安装后刷新页面。

每个版本会自动发布到 [GitHub Releases](https://github.com/RedCarl/dsh-date-sync/releases)（`v1.3.2` 起）。离线或锁定版本时，下载对应的 `*.tgz`，用本地绝对路径安装：

```bash
dsh plugin --profile web add /absolute/path/dsh-date-sync-1.3.2.tgz
```

本地开发时仍然可以链接目录：

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-date-sync
```

## 更新

插件启动约 8 秒后检查 [GitHub Releases](https://github.com/RedCarl/dsh-date-sync/releases)，之后每 6 小时检查一次；「高级 → 检查更新」可以手动触发。

发现新版本时，面板会显示「新版本 vX 可用 · 更新」：

- **本地 `link:` 安装**：执行 `git pull --ff-only` 更新源码，工作区有未提交改动时会拒绝；成功后自动重载插件
- **打包安装**：通过 `pluginManager` 安装 Release 里的新版 `tgz`，自动重载
- 更新完成后刷新页面即可

如果不需要自动检查，在配置文件里设 `checkUpdates: false`。

## 左侧栏面板

安装并刷新页面后，左侧栏图标栏会出现一个云同步图标（与插件、日程等图标并列）。点击后主区域打开 **数据同步** 面板：

- **顶部状态与操作**：运行中 / 同步中 / 已暂停 / 未配置 / 需要注意，以及「立即同步」「暂停 / 恢复」。
- **侧栏角标**：图标右上角的小圆点，绿色表示最近一次同步成功连上服务器，红色表示连接失败或尚未配置；暂停时不显示角标。
- **连接配置**：地址、用户名、密码 / 密码环境变量、远程根目录、拉取间隔、冲突策略、删除策略、本地监听开关、五个同步范围。点「保存并应用」后配置立即生效，同步引擎会就地重启，无需重启 Harness。
- **同步状态**：最近同步时间、远程位置、配置文件、冲突备份数，以及累计上传 / 下载 / 冲突 / 失败 / 跟踪文件数。
- **本机范围**：每个作用域的本地路径、远端路径、已跟踪文件数和目录是否存在。
- **提示**：配置错误、最近一次失败、缺失的插件包、不可跨机复用的 `link:` 依赖。
- **最近活动**：上传、下载、冲突、删除和错误，每 2.5 秒自动刷新。

面板保存的配置写入 `$DSH_HOME/date-sync/config.json`（权限 0600），**优先于** profile patch 里的同名字段；因此密码不需要写进会被同步的 patch。该文件不参与同步。

安装后如果面板没有立即出现，刷新一次页面即可；之后的启动会直接加载。

## 配置

安装后 profile 的 `cordis.patch.yml` 会出现：

```yaml
- id: date-sync
  name: 'dsh-date-sync'
  config:
    provider: webdav   # webdav | s3
    url: ''            # WebDAV 地址或 S3 endpoint，填了才启用
    bucket: ''         # S3 模式必填
    region: us-east-1
    username: ''
    passwordEnv: DSH_WEBDAV_PASSWORD
    remoteRoot: dsh-sync
```

### 在 YAML 中配置

在 profile 的 `cordis.patch.yml` 中按 id 覆盖（匹配的覆盖会**整体替换** `config`，请把要保留的字段一起写上），或者直接改上面的行：

```yaml
- id: date-sync
  name: 'dsh-date-sync'
  config:
    enabled: true
    url: 'https://dav.example.com/remote.php/dav/files/me/harness'
    username: 'me'
    passwordEnv: 'DSH_WEBDAV_PASSWORD'   # 推荐：密码放环境变量
    # password: '直接写在配置里也可以，但会明文保存'
    remoteRoot: 'dsh-sync'

    pollIntervalMs: 15000    # 拉取间隔；最小 1000
    debounceMs: 800          # 本机改动合并窗口
    settleMs: 1500           # 刚写入不足该毫秒数的文件先不推，避免半截文件
    requestTimeoutMs: 20000
    maxFileBytes: 67108864   # 单文件上限，超过则跳过并告警

    conflictPolicy: 'newest-wins'  # newest-wins | local-wins | remote-wins
    deletions: 'propagate'         # propagate | restore

    watch: true
    syncOnStart: true
    tool: true

    scopes:
      skills: true
      agentSkills: true
      sessions: true
      profile: true
      credentials: false

    exclude: []               # 额外的 glob，相对路径；node_modules/.git/*.lock 已内置排除
```

`url`、`username`、`password` 支持 `$VAR` / `${VAR}` / `~` 展开。密码也可以直接放在 URL 的 userinfo 里（`https://user:pass@host/dav`），插件会把它拆出来并做脱敏。

### 面板与 YAML 的优先级

面板保存的值（`config.json`）覆盖 patch 行中的同名字段，包括显式清空的字符串；`scopes` 按键合并。清除面板密码后，会回退到 patch 行或环境变量中的密码。

### 只同步部分内容

```yaml
    scopes:
      skills: true
      sessions: false
      profile: false
```

### 机器专属配置

profile 的 patch 会同步到所有机器，所以**不要**把 `cwd`、本机绝对路径、本机 shell 之类的设置放进去。DSH 的 home 级 patch（`$DSH_HOME/cordis.patch.yml`）优先级高于 profile patch，且不在同步范围内，适合放机器专属覆盖。

### 插件包

`package.json` 的 `dsh.profile.bundles` 和 `dependencies` 会同步，但 `node_modules` 不会。新机器拉到新的 bundle 后需要执行一次：

```bash
dsh plugin --profile web add <package>
```

`webdav_sync` 工具的 `status` 会列出 `missingBundles`，告诉你缺哪些包。

以 `link:` / `file:` 方式安装的插件（包括本插件自己）依赖本机绝对路径，不能直接跨机器使用。`status` 里的 `localLinkDependencies` 会列出它们；每台机器需要各自安装一次，或者把插件发布到 npm 后再用版本号安装。

## 冲突与删除

- 每个文件在本地状态文件里记录上次成功同步的 **内容哈希** 与 **远端 ETag**。两边都没变则零成本跳过。
- 只有一边变：直接上传或下载。
- 两边都变：按 `conflictPolicy` 处理。`newest-wins`（默认）比较本地文件 mtime 与远端 `Last-Modified`（对端上传时间），较新的一方胜出；**失败的一方不会被丢弃**，会写到：
  - `<stateDir>/conflicts/<时间>-<作用域>/local/…`（本地输）
  - `<stateDir>/conflicts/<时间>-<作用域>/remote/…`（远端输）
- 本地删除：远端文件被 `DELETE`。
- 远端删除：本地文件移到 `<stateDir>/trash/<时间>-<作用域>/…`，不做硬删除。
- `deletions: restore` 可以把删除变成“从另一边恢复”。

状态目录默认 `$DSH_HOME/date-sync/`，包含 `state.json`、`conflicts/`、`trash/`。换 WebDAV 地址时状态会自动重置，**不会**删文件。

## 安全

- 凭据：密码推荐用 `passwordEnv` 指向环境变量；若直接写进配置，它会随 profile patch 一起被同步到 WebDAV。
- `credentials` 作用域默认关闭。开启后 `.credentials.yaml` 会以**明文**上传到 WebDAV，请确保服务端和传输（HTTPS）可信。
- `state.json` 不保存密码，只保存 ETag/哈希。
- 远端写入使用 `If-Match` / `If-None-Match` 条件请求，避免静默覆盖对端并发修改。

## 校验

插件会拒绝把明显会破坏启动的文件写进本地：

- `package.json` 必须是合法 JSON 对象；
- `cordis.patch.yml` 不能为空/只有注释，且必须是 YAML 列表（以 `-` 或 `[` 开头）。

被拒绝的版本会记录在 `state.json` 的 `rejectedEtag` 中，同一版本不会反复重试；远端再变一次就会重新尝试。

## 工具

模型可以调用 `webdav_sync`：

| action | 作用 |
|---|---|
| `status` | 配置、作用域、计数、冲突数、最近日志 |
| `sync` | 立即执行一次完整双向同步 |
| `pause` / `resume` | 暂停 / 恢复自动同步 |

## 开发与测试

```bash
node test/sync-test.mjs   # 本地起一个临时 WebDAV 服务，模拟两台机器
node test/panel-test.mjs  # 用假的 Cordis Context 驱动面板 JSON 接口
node test/s3-test.mjs     # 本地 S3 服务（验证 SigV4）+ 双机器同步
node test/client-test.mjs # 在隔离 VM 中执行 Client 模块并检查 slot 注册
```

同步测试覆盖：首次同步、双向增量、中文路径、冲突（含失败方留档）、删除传播、第三方直接上传、非法 patch 拒绝、活动会话延后、幂等、监听推送、轮询拉取、根目录丢失保护。

面板测试覆盖：状态接口、配置读取（不泄露密码）、方法限制、非法配置拒绝、保存落盘权限、引擎热重启、YAML 与面板配置的优先级、清除密码回退、手动同步 / 暂停 / 恢复、S3 模式保存、非 JSON 请求拒绝。S3 测试覆盖：SigV4 签名、ListObjectsV2 分页、首同步、双向增量、删除传播、条件写入、幂等。Client 模块测试覆盖：工厂 ID、注入列表、slot 注册选项、图标 SVG、中英文字典键一致性。

## 连接排查

同步失败时面板和 `$DSH_HOME/date-sync/sync.log` 会写出底层原因。常见错误：

| 日志 | 含义与处理 |
|---|---|
| `fetch failed ← ECONNRESET` | TCP 能连上，但发送 HTTP/TLS 后被对端重置。通常是端口未对外开放、防火墙/反向代理只允许特定来源、端口要求 PROXY 协议，或该端口并不是 WebDAV。用 `curl -vk https://host:port/` 对比 |
| `ENOTFOUND` | 域名解析失败，检查 URL 拼写或 DNS |
| `CERT_HAS_EXPIRED` / `DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 证书不被 Node 信任。把 CA 证书放进文件，设置 `NODE_EXTRA_CA_CERTS=/path/ca.pem` 后重启 Harness；自签名也可改用受信任证书 |
| `401` / `403` | 账号、密码或权限问题 |
| `404` | URL 少了 WebDAV 根路径（如 `/dav`、`/remote.php/dav/files/me`） |
| `SignatureDoesNotMatch` | S3 Access Key / Secret Key 错误，或 region 与服务端不一致 |
| `NoSuchBucket` | bucket 名称错误或没有权限 |
| `AccessDenied` | S3 凭据缺少 ListBucket / GetObject / PutObject / DeleteObject 权限 |
| `the server answered with an S3-style error` | 当前协议选错：把 S3 endpoint 当成 WebDAV，改用「S3 对象存储」模式 |

先确认 WebDAV 根地址：浏览器或 `curl -vk -X PROPFIND -H 'Depth: 0' <url>` 返回 207 才算可用。

## 已知限制

- WebDAV 没有服务端推送，远端改动最快也要一个轮询周期。
- 远端文件需要带 ETag（Nextcloud、群晖、Apache mod_dav、坚果云等都会返回）。
- 本插件没有 `Config` schema（本地目录安装的 bundle 无法解析 DSH 自带的 `schemastery`），所以 Settings 的插件页只显示条目；配置在左侧栏面板或 `cordis.patch.yml` 中完成。
- 会话目录保留 `--项目路径--` 前缀；两台机器的工作目录不同时，会话会落在各自的项目目录名下。
- 插件包本体不传输，见「插件包」一节。
- 冲突按“较新者胜”处理，依赖两台机器的时钟大致同步；不确定时用 `local-wins` / `remote-wins`。
- 大于 `maxFileBytes` 的文件会跳过，超大历史会话需要调大上限或关闭 `sessions` 作用域。
