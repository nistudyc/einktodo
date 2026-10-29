# 部署指南

## 1. 本地准备

先完成 README 中的依赖安装和三种字号字体生成，再执行：

```bash
cd cloudflare
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler kv namespace create EINK_KV
```

将新 namespace ID 填入 `wrangler.toml`。取消 `routes` 注释，填写自己控制的域名，并将 `AUTH_ORIGIN` 改为相同的 HTTPS origin。例如 `https://eink.example.com`。自定义域名需要满足 Cloudflare 的域名绑定条件；也可配置实际使用的 Workers 地址。

`wrangler.toml` 是本地私有配置，已加入 `.gitignore`，不要强制提交。也不要复用其他部署者的 namespace ID。

## 2. 创建必需 Secrets

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put DEVICE_TOKEN
npx wrangler secret put DATA_ENCRYPTION_KEY
```

- `ADMIN_PASSWORD`：密码管理器生成的高强度随机密码，用于首次管理员登录。请保存后再输入。
- `DEVICE_TOKEN`：与管理员密码不同的随机设备密钥，填入硬件配置的 API Key。
- `DATA_ENCRYPTION_KEY`：**32 个随机字节的 Base64**。可在本地使用 `openssl rand -base64 32` 生成；保存到安全位置后，输入 Wrangler 提示框。这个密钥丢失将无法读取已有加密数据。

不要将真实值粘贴到 GitHub、截图、命令参数、示例文件或聊天中。

## 3. 发布并绑定 Passkey

```bash
npm test
npm run build
npx wrangler deploy --dry-run
npx wrangler deploy
```

访问自己的 `https://<domain>/admin`，用初始密码登录并绑定 Passkey。绑定后，密码登录默认关闭。正式使用前先核对匿名 `/api/state` 和位图端点返回 401，再用自己的设备密钥验证取图。

设备配置：

```text
API URL: https://<domain>/api/display/v2
API Key: 你设置的 DEVICE_TOKEN
```

原始图片为 `ceil(width/8) * height` 字节；固件需正确解析位图尺寸和缓存头。

## 4. 飞书邮件数量（可选）

在自己的飞书租户中创建企业自建应用，按开放平台要求发布并启用：

1. 开通**应用身份** `mail:user_mailbox.message:readonly`，将邮件数据范围限制在需要显示数量的本人邮箱。
2. 在本地 `wrangler.toml` 的 `FEISHU_APP_ID` 中填写自己的 App ID。
3. 设置 Secrets：

   ```bash
   npx wrangler secret put FEISHU_APP_SECRET
   npx wrangler secret put FEISHU_MAILBOX
   ```

4. 邮箱值填写所需查询的邮箱标识/邮箱地址，确认该应用有访问权限。重新部署。

定时同步只列取 INBOX 未读邮件 ID 来统计数量，随后丢弃 ID。无需配置邮件事件订阅。未配置的签名事件入口保持关闭；不要为方便调试开放匿名写入。

## 5. 飞书任务（可选）

同一个自建应用开通**用户身份**：

- `task:task:read`：读取本人关联任务。
- `offline_access`：获取刷新凭据，支持云端持续同步。

在应用安全设置中增加**精确匹配**的重定向地址：

```text
https://<domain>/api/feishu/callback
```

按飞书要求发布应用变更。到墨屏后台点击“连接飞书待办”，由本人在飞书确认授权。此授权不替代后台 Passkey。

同步范围为本人负责、创建、分配及关注的未完成任务。后台连接后以飞书为源，在飞书编辑或完成任务，云端约一分钟内拉取。标题按创建时间升序固定展示。

如果遇到“已授权但暂未同步”，先看后台状态；已保存的有效授权会自动重试，不要反复授权。应用使用 `user_id_type=open_id`，并会继续获取过滤后为空但 `has_more=true` 的分页。

## 6. 运行与维护

- 设备离线时，后台强制刷新无法主动唤醒设备；等待设备下次联网取图。
- 云端同步、KV、Durable Objects 与天气接口受各服务的限额、计费及条款约束，请按自己的用量检查。
- 支持的字库以生成器中的字符范围为准。切换字体后必须重新生成并部署。
- 安全配置与恢复见仓库根目录 [SECURITY.md](../SECURITY.md)。
