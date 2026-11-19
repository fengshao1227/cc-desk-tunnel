# 原生部署（不用 Docker）

本 fork 的服务端可以不放进容器，直接作为 systemd 服务跑在普通用户下。服务端和这个用户自己终端里的 `claude` 用的是**同一个程序、同一份登录、同一个 `~/.claude`**：全局规则、skills、MCP 服务器（包括通过 SSH 用 Mac 上的工具，见 [custom/README.md](../../custom/README.md)）在 GUI 和 ccdt 里一样可用。

已在 CentOS 7 上验证：glibc 2.17、gcc 4.8、OpenSSH 7.4、OpenSSL 1.0.2。新的发行版上流程相同，只是更省事，见下文"老系统上额外做的事"。

## 版本

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| 服务端 | fork 的 `main`（当前 0.3.16） | 版本号跟随上游；**GUI 和 ccdt 必须与它同版本**，直接装上游发布页的客户端即可 |
| Node | v24.22.2 | 与上游镜像相同；glibc < 2.28 时用 unofficial-builds 的 `glibc-217` 构建 |
| Claude Code | 官方 `@anthropic-ai/claude-code` 2.1.328 | 由 `CLAUDE_CODE_VERSION` 指定；上游镜像锁的是 2.1.321。只用官方包，不改它 |
| OpenSSH 客户端 | ≥ 7.6 | 设备隧道的 ssh 配置用到 `RemoteCommand`；系统自带的版本太旧时，脚本自动编一份 9.9p2（先验 GPG 签名） |

## 安装

在服务器上以 root 执行。`claude` 是运行服务的普通用户，要先建好；选别的用户就设 `CCDT_USER`：

```bash
git clone https://github.com/fengshao1227/cc-desk-tunnel.git /tmp/ccdt && cd /tmp/ccdt
CCDT_HOST=<服务器公网地址> bash deploy/native/install.sh          # 可选参数：分支、tag 或 commit
```

脚本依次做这些事，每一步都可以重复执行：

1. 装 Node 24 和指定版本的 Claude Code，都放在 `~/opt` 下。系统自带的 ssh 低于 7.6 时，再补一个新版 ssh 客户端。
2. 把 fork 的源码拉到 `~/apps/cc-desk-tunnel/releases/<commit>`，然后装生产依赖，并针对这台主机的 glibc 编译 `node-pty`。
3. 准备网页前端：优先取上游同版本发布包里的 `apps/server/web`，取不到再用 Vite 现场构建。
4. 生成自签证书、`service.env`（凭据随机生成）、设备提示词模板和空的项目映射表，都放在 `~/.config/cc-desk-tunnel/`。已经存在的文件不会被覆盖。
5. 在回环地址的 18787 端口上用临时数据目录试启动一次，确认能起来后，才切换 `current` 链接、写入 systemd 服务并启动。

装完会打印客户端要填的地址和证书指纹。凭据在 `service.env` 里，不打印出来。防火墙或安全组只需放行一个端口（默认 8787）。最后以该用户身份运行一次 `claude`，执行 `/login` 登录。GUI 和 ccdt 会沿用这份登录，不用再登。

## 配置：`~/.config/cc-desk-tunnel/service.env`

除上游已有的 `PROXY_*` 和 `CLAUDE_*` 外，本 fork 新增三项。不设置时，行为和上游完全一样：

| 变量 | 作用 |
| --- | --- |
| `CCDT_DEFAULT_PERMISSION_MODE` | 新会话的审批模式。还停在上游默认值 `auto` 的会话也按它运行；手动选过的模式不受影响。示例配置里是 `bypassPermissions` |
| `CCDT_DEVICE_PROMPT` | 用你自己的模板替换上游的设备提示词（上游原文是"一切走 ssh，不许用本机工具"）。占位符：`{{device}}` `{{project}}` `{{script}}` `{{command}}` `{{session}}`。示例见 `device-prompt.example.md` |
| `CCDT_PROJECT_MAP` | `设备文件夹\|服务器文件夹` 一行一条，格式与 claudemax 的 `projects.conf` 相同。列在表里的项目，第一次建会话时会把工作目录做成指向该服务器文件夹的软链接。这样 GUI、ccdt 和直接运行的 `claude` 共用会话列表、项目记忆和项目 CLAUDE.md。可以用 `custom/server/sync-project-map` 定时从各台 Mac 汇总这张表 |

改完执行 `systemctl restart cc-desk-tunnel`。注意重启会结束正在运行的会话，对话内容会保留。

## 升级与回滚

上游出新版本时，先在开发机上把 fork 更新好：

```bash
git fetch upstream --tags
git merge v0.3.17                 # 有冲突就解决；本 fork 对上游文件的改动只有十几行
npm test                          # 至少跑 apps/server/test/customizations.test.ts
git push origin main
```

再到服务器上执行：

```bash
bash deploy/native/upgrade.sh            # 构建 main → 冒烟测试 → 切换 → 等没有会话在跑时再重启
bash deploy/native/upgrade.sh --now      # 不等，立即重启
bash deploy/native/upgrade.sh --rollback # 回到上一个版本
bash deploy/native/upgrade.sh --list     # 列出保留的版本（最近 5 个）
```

新版本构建在旧版本旁边的目录里，切换前不影响正在运行的服务。`node-pty` 版本没变时直接复用上一版的编译结果，不用 Docker。版本号变了以后，要把各台 Mac 上的 GUI 和 ccdt 换成同一版本，二者都从上游发布页下载。

客户端里的"升级服务端"按钮是基于 Docker 的，原生部署下用不了，请用 `upgrade.sh`。

## 老系统上额外做的事（CentOS 7 实测）

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| OpenSSH 7.4 不认识 `RemoteCommand` | 连上 7 秒左右就断开，关闭码 4003（SSH probe failed） | 自动编一个 9.9p2 客户端（`--without-openssl`，隧道只用 Ed25519），只放在服务的 PATH 最前面，不动系统的 `/usr/bin/ssh` |
| gcc 4.8 编不了 `node-pty`（Node 24 头文件需要 C++20） | `require('node-pty')` 失败 | 在 `manylinux2014` 容器里编译（gcc 10 + glibc 2.17），产物可以直接在宿主机加载。Docker 只在构建时用到 |
| OpenSSL 1.0.2 不支持 `req -addext` | 上游的 `manage.sh init` 生成证书时静默失败 | `install.sh` 改用配置文件的写法生成证书 |
| 官方 Node 24 需要 glibc 2.28 | node 启动失败 | 改用 unofficial-builds 的 `glibc-217` 构建 |
| systemd 219 不认识 `MemoryMax` | 日志里有一条警告 | 服务文件里同时写了 `MemoryLimit` 和 `MemoryMax` |

## 文件位置

| 用途 | 路径 |
| --- | --- |
| 程序 | `~/apps/cc-desk-tunnel/current`，指向 `releases/<commit>` |
| 配置、证书、提示词模板、项目映射表 | `~/.config/cc-desk-tunnel/` |
| 会话数据 | `~/.local/share/cc-desk-tunnel/state/` |
| Node、Claude Code、OpenSSH | `~/opt/node24`、`~/opt/claude-code`、`~/opt/openssh-*` |
| 日志 | `journalctl -u cc-desk-tunnel` |
