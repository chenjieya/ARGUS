# 服务器安全加固记录

> 记录时间：2026-11-04
> 主机：VM-0-9-debian（152.136.107.93 / 10.2.0.9），Debian 12

## 一、发现的安全事件

### 1. SSH 密码被爆破命中

`alvis` 账号的密码在公网 SSH 爆破中被命中。30 天内共有 **9 个不同的云主机 IP** 使用同一套凭据成功登录：

| IP | 归属 | 成功登录次数 |
| --- | --- | --- |
| `52.242.243.7` | AWS ap-northeast-1（东京） | 7 |
| `52.173.179.39` | Azure | 7 |
| `52.160.227.34` | Azure | 7 |
| `4.246.135.34` | Azure | 7 |
| `20.98.135.178` | Azure | 7 |
| `20.169.52.163` | Azure | 7 |
| `172.214.44.52` | Azure | 7 |
| `172.202.78.7` | Azure | 7 |
| `35.210.83.117` | GCP（仅扫描，未登录成功） | 0 |

特征：每个 IP 恰好登录 **7 次**，每次会话 2-5 秒即断开。这是僵尸网络拿到已知凭据后做有效性验证的标准行为——命中即登记，后续由真正的利用方接手。7 天内失败尝试 **3100 次**，说明 22 端口长期处于高强度爆破下。

### 2. 取证结论：未发现落地痕迹

已逐项排查，均无异常：

- `/etc/passwd`、`/etc/shadow`、`/etc/group` 无新增账号（`newuser`、`libenhao` 为 2026-08-05 装机时创建，`lastlog` 显示从未登录）
- `authorized_keys` 仅两个文件：`/root/.ssh/authorized_keys`（仅腾讯云运维 RSA）与 `/home/alvis/.ssh/authorized_keys`（部署密钥 + 你自己的 RSA）
- `/etc/cron.d/`、`/var/spool/cron/crontabs/`、用户 crontab 无新增任务
- `/etc/ld.so.preload` 不存在，`/etc/environment`、`/etc/profile*`、`.bashrc` 无 `LD_PRELOAD` 注入
- 无 `kdevtmpfsi` / `kinsing` 类挖矿进程，无异常 `dbus` 常驻（`/tmp/.X11-unix` 下无 socket）
- `/tmp`、`/var/tmp`、`/dev/shm` 无可疑可执行文件
- 无新增 systemd 服务单元

> `nest-app-1` / `nest-weather-1` 容器创建于 13:57:19（攻击者最后一次登录后 21 秒），经核实是同期一次正常部署：镜像来自 `ghcr.io/chenjieya/`，`.env.weather` 早在 12:24 已存在，部署目录由 `alvis` 持有，容器健康运行。

### 3. 公网暴露的数据库端口

`mysql-dev` 与 `alfred_vaults` 以 `0.0.0.0` 发布端口，**无任何防火墙拦截**，可直连：

- `3306` → `mysql-dev`（MySQL 8.0.44）
- `14777` → `alfred_vaults`（凭据管理服务）

`mysql-dev` 的 `MYSQL_ROOT_PASSWORD` 环境变量为 `765321`（该密码已失效，实测 root 无法登录），应用账号 `xiaozhai` 的密码与用户名相同。该库实际只含 `information_schema` / `performance_schema`，202M 数据全为系统库，无业务数据。

## 二、已执行的加固措施

### 1. 更换 SSH 密码

```bash
echo "alvis:<新密码>" | sudo /usr/sbin/chpasswd
```

注：Debian 12 上 `chpasswd` 位于 `/usr/sbin/`，`sudo` 的 PATH 不含该路径，须用绝对路径。

验证：新密码登录成功，旧密码返回 `AuthenticationException`。

### 2. 安装并配置 fail2ban

```bash
sudo apt-get install -y fail2ban
```

`/etc/fail2ban/jail.d/sshd.local`：

```ini
[sshd]
enabled = true
backend = systemd
port = ssh
filter = sshd
maxretry = 5
findtime = 1h
bantime = 24h
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 4w
ignoreip = 127.0.0.1/8 ::1 111.0.124.49 116.148.75.197 106.47.44.21
```

关键点：

- `backend = systemd` —— Debian 12 的 sshd 日志进 journald，默认 `auto` 可能读不到，导致过滤失效
- `ignoreip` 必须包含自己的常用出口 IP，否则连错 5 次密码会把自己封在门外
- `bantime.increment` 让反复触发的 IP 封禁时长指数递增，最高 4 周

### 3. 封禁 DOCKER-USER 端口

Docker 发布的端口走 **FORWARD** 链，不经过 INPUT，因此 ufw 与 INPUT 规则对它们无效。唯一有效的位置是 `DOCKER-USER` 链：

```bash
sudo /sbin/iptables -I DOCKER-USER 1 -p tcp -m multiport --dports 3306,14777 \
  -j DROP -m comment --comment "argus-close-db"
```

持久化（Docker 重启会重建链，规则会丢）：

`/etc/systemd/system/docker.service.d/argus-firewall.conf`：

```ini
[Service]
ExecStartPost=/bin/sh -c "iptables -C DOCKER-USER -p tcp -m multiport --dports 3306,14777 -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -p tcp -m multiport --dports 3306,14777 -j DROP"
```

```bash
sudo systemctl daemon-reload
```

### 4. 启用 ufw（兜底）

```bash
sudo /usr/sbin/ufw default deny incoming
sudo /usr/sbin/ufw default allow outgoing
sudo /usr/sbin/ufw allow 22/tcp
sudo /usr/sbin/ufw allow 80/tcp
sudo /usr/sbin/ufw allow 443/tcp
sudo /usr/sbin/ufw --force enable
```

> 注意：本机 INPUT 链上腾讯云已挂 `YJ-FIREWALL-INPUT`（122K 包已过），且它的位置在 ufw 链之前。ufw 在此环境下只作兜底，**不能替代 DOCKER-USER 规则**。不要去删改腾讯云的链。

## 三、验证结果

| 检查项 | 结果 |
| --- | --- |
| SSH 密钥登录 | `KEY-LOGIN-OK` |
| SSH 密码登录（新密码） | OK |
| SSH 密码登录（旧密码） | 拒绝 |
| fail2ban 状态 | active，已封 9 个 IP |
| `3306` 外网可达 | 已阻断（超时） |
| `14777` 外网可达 | 已阻断（超时） |
| `22` / `80` / `443` | 正常开放 |
| `nginx -t` | successful |
| 运行中容器 | 14 个全部 Up，argus `Up (healthy)` |
| `https://status.alvis.org.cn/api/health` | 200 |

`5173`、`9527`、`8080` 仍对外开放，为三个前端演示站，保持原状。

## 四、遗留事项

1. **`14777` 的 `alfred_vaults` 是凭据管理服务**，端口现已封堵，但若它此前被外部访问过，其中的密钥应视为可能泄露，建议轮换。
2. **`mysql-dev` 的 `xiaozhai` 账号密码等于用户名**，虽然端口已封，仍建议改为强密码；root 的环境变量 `765321` 与实际密码不一致，建议清理该环境变量避免误导。
3. **建议最终关闭 SSH 密码登录**，改为纯密钥。前置条件：确认你所有常用设备（含 `172.214.44.52` 之外的、持有那把 RSA 私钥的设备）都已能密钥登录。关闭方式：

   ```bash
   sudo sed -i 's/^PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
   sudo systemctl restart ssh
   ```

   务必先另开一个会话保活验证，再退出当前会话。
4. **GitHub 上的旧 commit** 仍可能通过 SHA 直接取到（内含 `.tools/rsh.py` 的旧密码）。密码已更换，风险已消除，无需额外处理。
