# AGENTS.md

本文件是项目约定，供自动化代理与协作者参考。内容只描述仓库中实际存在的技术栈、命令与结构。

## 项目概览

Abacus 是 Firefly III 的移动客户端，基于 Expo + React Native，支持 iOS 与 Android。

## 技术栈

- Expo SDK 54 / React Native 0.81 / React 19 / TypeScript 5.9
- 状态管理：Redux + rematch（`@rematch/core`、`loading`、`persist`）
- 本地存储：`expo-sqlite`（离线缓存、outbox、notices）+ AsyncStorage（小对象持久化）
- 网络：axios；凭证存于 `expo-secure-store`
- 图表：victory-native + react-native-svg
- 测试：jest（jest-expo 预设）+ Detox（端到端）

## 常用命令

| 目的 | 命令 |
|---|---|
| 启动 Metro | `npm start` |
| 构建并运行 Android | `npm run android` |
| 构建并运行 iOS | `npm run ios` |
| 单元测试 | `npm test`；单文件：`npx jest <path> --runInBand` |
| 类型检查 | `npx tsc --noEmit` |
| Lint | `npm run lint` |
| 端到端测试 | `npm run test:e2e`（需要 `DETOX_TEST_URL`、`DETOX_TEST_TOKEN`） |
| 生成原生工程 | `npx expo prebuild --platform android --no-install` |
| 出签名 APK | `.\scripts\build-android-release.ps1` |

Android 相关配置（包名、minSdk、备份规则）都在 `app.config.js` 与 `plugins/` 中，修改后必须重新 `expo prebuild` 才生效。`android/` 目录不提交（`.gitignore` 已忽略）。

## 目录结构

- `src/components/Screens`：页面
- `src/components/UI`：通用组件（`ALibrary` 下的 AText/AStack/AButton 等）
- `src/components/Charts`：图表
- `src/db`：本地库与同步（`schema`、`repository`、`outbox`、`sync`、`syncPush`、`syncPull`、`syncBlobs`、`useBlob`、`useSyncSummary`）
- `src/lib`：工具（`network`、`syncContext`、`syncScheduler`、`syncTriggers`、`case`、`formParams` 等）
- `src/models`：rematch 模型
- `src/routes`：导航
- `src/store`：store 与 persist 配置
- `src/i18n/locale/translations`：15 个语言文件
- `src/images`、`src/fonts`：静态资源
- `plugins/`：Expo config plugin（Android manifest、备份规则、release 签名、Gradle 内存）
- `scripts/`：本机打包脚本；`android-release.local.json` 含密钥，已 gitignore
- `e2e/`：Detox 用例

## Android 发布构建

只出 APK，ABI 固定 `arm64-v8a`；签名由 `plugins/withReleaseSigning.js` 注入 `android/app/build.gradle`，prebuild 后自动恢复。

```powershell
.\scripts\build-android-release.ps1                  # prebuild + assembleRelease
.\scripts\build-android-release.ps1 -SkipPrebuild     # 只重打包 JS/资源，改 JS 后用这个
```

脚本会：解析 SDK/JDK/keystore → `expo prebuild` → `gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a` → `apksigner` 校验 → 复制到 `dist/abacus-<version>-<versionCode>-arm64-v8a.apk`。

ABI 只在 release 命令行收窄，`android/gradle.properties` 保留模板默认的四个 ABI，因此模拟器 debug 构建不受影响。需要模拟器 release 包时：`-Architectures arm64-v8a,x86_64`。

配置来源优先级：命令行参数 > 环境变量（`ANDROID_HOME`、`JAVA_HOME`、`ABACUS_UPLOAD_*`）> `scripts/android-release.local.json` > 内置默认值。缺少密码时会交互式输入。

`versionCode` 位于 `app.config.js`，每次上架必须递增。`android/` 是生成目录，不要手改，改配置请写 config plugin。

## 分支与工作流

本仓库长期存在两条分支，职责不同，不要混用：

| 分支 | 内容 | 推送 |
|---|---|---|
| `develop` | 与上游一致，只用来同步 fork | `origin/develop` |
| `liaocl` | 个人工作分支：离线库与同步功能 + 个人打包配置 | 可推送 |

`liaocl` 同时携带个人打包配置：`app.config.js`（`liaocl` 包名、versionCode、关闭 OTA）、`plugins/withAndroidManifest.js`（备份规则）、`plugins/withReleaseSigning.js`、`plugins/withGradleMemory.js`、`scripts/build-android-release.ps1`、`src/config/__tests__/`（4 个）。

因为包名与发布配置也在这条分支里，**不要整条分支提 PR 到上游**；需要上游功能时，把对应提交 cherry-pick 到基于 `develop` 的临时分支再提。

`scripts/android-release.local.json` 不提交，由 `.gitignore` 忽略。`AGENTS.md` 已入库（仅存在于 `liaocl` 分支）：切到 `develop` 做上游同步时该文件会从工作区消失，切回 `liaocl` 即恢复，属于预期行为。

### 日常操作

```powershell
# 打 APK：直接在 liaocl 上执行，不需要切分支
.\scripts\build-android-release.ps1
.\scripts\build-android-release.ps1 -SkipPrebuild   # 只改 JS/资源时

# 推送到个人 fork
git push origin liaocl
```

### 同步上游

```powershell
git switch develop
git pull
git switch liaocl
git rebase develop
```

rebase 若在 `app.config.js` 或 `plugins/withAndroidManifest.js` 上冲突，保留本地的打包配置部分。

## 项目约定

- 代码标识符、API 字段、文件路径保持英文；注释与文档可用中文。
- 新增 i18n key 必须同时写入全部 15 个翻译文件。缺失时会 fallback 到 `en-US`，但界面会出现未翻译文案。
- 数据访问统一走 `src/db/repository.ts`；所有 SQL 必须带 `scope_id`，且一律使用绑定参数，禁止拼接用户数据。
- 账户数据按 `scope_id` 隔离；任何跨账号读取都是缺陷。
- 离线时只允许交易的新建/编辑；账户、分类、预算、储蓄罐、币种的写入口必须禁用。
- 同步状态、冲突、服务端删除、连接告警都必须由用户手动关闭，不允许自动消失。
- 新增或调整任何与上游不同的改动（功能、配置、构建流程、依赖）后，必须同步更新 `README.md` 顶部的「相较上游的主要修改点」列表；内容以 `git diff develop..liaocl` 的实际差异为准，不允许遗漏或凭印象编写。
- 提交由用户发起：本项目不自动执行 `git commit` / `push` / `merge`。

## 已知问题

- `src/components/UI/ALibrary/AInput.tsx` 有 2 个既有 `tsc` 错误（`FocusEvent` / `BlurEvent` 类型不匹配），与业务无关。
- Windows 检出为 CRLF，`npm run lint` 会报大量 `linebreak-style`；CI 使用 LF 检出，不受影响。
- 在 git worktree 中直接运行 eslint 会级联读取主仓库配置并失败，需改用 `npx eslint --no-eslintrc --config .eslintrc.json --resolve-plugins-relative-to . <path>`。

## 测试注意

- `expo-sqlite` 等原生模块不能在 Node 的 jest 中真实执行。数据层用纯函数单测覆盖，DB 行为由 Detox 与真机验证。
- 改动同步、离线或数据层时，先跑 `npx jest src/db --runInBand`；涉及 UI 时再跑全量 `npm test`。
- Detox 用例需要可用的 Firefly III 实例与 token，环境变量缺失时会直接失败。
