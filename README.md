# 定向帖子助手

Chrome MV3 侧边栏扩展和本机模型网关，用于整理公开帖子的需求，管理租房、美妆等业务模板。当前扩展版本见 [manifest.json](apps/extension/public/manifest.json)。

## 功能

- 找需求：只读分析首页或搜索结果，保存到本机 SQLite，支持标签、已查阅/未查阅列表及人工打开帖子。
- Auto：按列表顺序进行标题初筛、详情分析和服务匹配；点赞、关注、评论需用户显式开启。
- 防重复：同账号同帖已有发布记录或发送结果不明时保留锁定并跳过，不盲目重发。
- 异常暂停：登录验证、账号限制、页面异常及无法确认返回列表时停止，不绕过平台验证或限制。

请遵守平台规则，避免批量骚扰或垃圾信息。测试用例与模拟页面通过不代表真实平台允许自动操作，也不代表所有真实页面都已验收。

## 项目结构

```text
apps/extension/   Chrome 扩展、侧边栏、页面操作与本地状态
apps/gateway/     本机 Fastify 网关、模型提示词、SQLite 需求记录
packages/shared/  业务模板、校验契约与共享规则
fixtures/         虚构测试页面
scripts/          公开源码敏感信息检查
```

## 本地启动

使用 Node.js 和 [package.json](package.json) 中指定的 pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @yuezhuang/gateway dev:mock
```

在 Chrome 的 `chrome://extensions` 开启开发者模式，加载 `apps/extension/dist`。本机网关默认监听 `127.0.0.1:3417`。Mock 模式用于开发，不支持真实模型 Auto 流程。

## 私有模型配置

仓库不包含 API 密钥、后端 Token、实际网关地址、私有证书或运行数据库。复制空模板后，只在本机填写：

```sh
cp gateway.env.example gateway.env
```

`gateway.env` 已被 Git 忽略。可用配置：

- `APP_MODE`：默认 `mock`；配置真实模型时改为 `real`。
- `MODEL_API_ORIGIN`：你自己的兼容模型服务 HTTPS 地址。
- `MODEL_API_KEY`：模型服务密钥，只放在后端私有配置中。
- `MODEL_ID`：服务实际支持的模型名称。
- `GATEWAY_PAIRING_TOKEN`：建议设置独立随机 Token，并在扩展设置中填写对应配对 Token；不要填写模型 API 密钥。

```sh
pnpm --filter @yuezhuang/gateway dev
```

也可以通过进程环境变量配置，或用 `YUEZHUANG_ENV_PATH` 指向仓库外的私有配置文件。如果服务需要额外 CA，请自行验证并通过 `NODE_EXTRA_CA_CERTS` 指定本机证书；不要上传证书或关闭 TLS 校验。

模型接口采用兼容的 Responses 格式并请求 `store: false`。开启分析会将公开帖子的相关内容发送至你配置的模型服务，请先确认该服务的数据处理方式。本机 SQLite 数据、浏览器状态、日志和内部部署记录不属于公开源码。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm package:extension
pnpm --filter @yuezhuang/extension verify:like-bundle
pnpm test:public-secrets
pnpm check:public-secrets
```

提交前检查 Git 暂存内容，而不是仅检查工作目录：

```sh
node scripts/check-public-secrets.mjs --staged
```

检查器仅报告文件、行号和规则，不输出疑似密钥。CI 检查受版本控制的内容；自动检查不能取代人工审查。构建产物和 ZIP 不提交到源码仓库。

请不要强制添加私有配置，也不要在 Issue、截图或日志中粘贴 Token。安全说明见 [SECURITY.md](SECURITY.md)。
