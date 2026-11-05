> [!IMPORTANT]
> **本仓库是个人维护的自定义分支，非上游官方代码。**
>
> 当前分支 [`liaocl`](https://github.com/liaochuan/abacus/tree/liaocl) 基于上游 [victorbalssa/abacus](https://github.com/victorbalssa/abacus) 的 `develop` 分支，加入了离线优先与双向同步等个人改造。
>
> **This repository is a personal fork. The `liaocl` branch is based on upstream `develop` and is not official upstream code.**
>
> - **与上游的关系**：`develop` 始终保持与上游 `victorbalssa/abacus:develop` 一致，只用于同步；`liaocl` 是实际使用和打包的分支。\
>   **Relation to upstream**: `develop` mirrors `victorbalssa/abacus:develop` and is only used for syncing; `liaocl` is the branch actually used and built.
> - **同步上游**：不定期把上游 `develop` 变基（rebase）到 `liaocl`，所以本分支的提交历史可能被重写，请不要基于它做长期开发，也不要依赖固定的 commit SHA。\
>   **Syncing**: upstream `develop` is rebased into `liaocl` from time to time, so history may be rewritten. Don't build long-lived work on this branch or depend on specific SHAs.
> - **为什么不向上游提 PR**：这些改动主要由 AI 辅助开发，没有经过完整的代码审查和充分的真实场景验证，并且混入了个人打包配置（包名、签名、版本号）。提交 PR 会给上游维护者带来审查负担、污染上游代码，因此不提交。若你需要其中某项功能，建议自行 fork 后挑选实现，或先到上游开 issue 讨论。\
>   **Why no upstream PR**: the changes are mostly AI-assisted, have not gone through a full code review or real-world validation, and include personal build config. Opening a PR would burden upstream maintainers with reviewing unverified code, so none is submitted.
> - **许可证**：沿用上游 [GPL-3.0](LICENSE)。个人分支不提供使用支持。\
>   **License**: follows upstream [GPL-3.0](LICENSE). No support is provided for this fork.

**相较上游的主要修改点 / What changed compared to upstream**

1. **离线优先本地存储与双向同步 / Offline-first storage and two-way sync**
   新增 `src/db/`：基于 `expo-sqlite` 的表结构、按 `scope_id` 隔离的读写、outbox、拉取与推送、blob 缓存与清理、旧数据迁移。
2. **同步调度与触发 / Sync scheduling and triggers**
   `src/lib/syncScheduler.ts`、`syncTriggers.tsx`、`syncContext.ts`，配合 `@react-native-community/netinfo`：启动、回到前台（距上次成功不足 5 分钟则跳过）、网络恢复、下拉刷新/手动、outbox 有积压时的 60 秒重试。
   保存交易后先只推送该交易，整轮同步延后 3 秒合并执行，连续保存只跑最后一次。
3. **同步状态与冲突提示 / Sync status and conflict UI**
   新增顶栏同步图标（`SyncStatusIcon`）、同步事项弹窗（`SyncNoticeModal`）与列表（`SyncIssueList`）；冲突、服务端删除、连接告警必须由用户手动关闭，不会自动消失。
   首页、交易列表、交易详情页在同步后自动刷新；图表只补缺失的缓存维度。
4. **离线读写边界 / Offline write rules**
   离线时交易的新建与编辑会写入本地 outbox，联网后自动推送；其余直接写服务端的操作（如交易复制、删除）由 `useOnlineGuard` 拦截并提示。
   交易表单中的账户/分类自动补全在离线状态下也可用。
5. **国际化 / Translations**
   新增离线与同步相关的 i18n key，并补齐全部 15 个语言文件；除 `zh-CN` 外多数语言目前是英文占位文案，个别为机器翻译，准确性不保证。
6. **Android 个人打包配置 / Personal Android build config**
   包名改为 `abacus.fireflyiii.android.liaocl`（debug 为 `.dev`）；关闭 Expo OTA 更新；`versionCode` 自行递增；`minSdkVersion 31`；
   新增备份/数据提取规则、release 签名插件（`plugins/withReleaseSigning.js`）、Gradle 内存插件与 `scripts/build-android-release.ps1`，只产出 `arm64-v8a` APK。iOS 未做验证。
7. **测试 / Tests**
   引入 jest 与 `@testing-library/react-native`，新增 `npm test` / `npm run test:e2e` 脚本；数据层、同步、UI、i18n 与 config plugin 均有单元测试。

---

<div align="center">
    <p></p>
  <img alt="logo" src=".github/img/icon.png" height=120 />
  <h1>Abacus: Firefly III mobile application</h1>
  <div>
    <a href="https://apps.apple.com/us/app/1627093491"><img width="180" src=".github/img/apple.svg" /></a>
    <a href="https://play.google.com/store/apps/details?id=abacus.fireflyiii.android.app"><img width="180" src=".github/img/google.svg" /></a>
  </div>
  <p></p>
  <div>
    <img alt="chart" src=".github/img/light-demo.gif" />
    <h6>Light Mode</h6>
    <img alt="chart" src=".github/img/dark-demo.gif" />
    <h6>Dark Mode</h6>
  </div>
  <p></p>
  <sup>

![size](https://img.shields.io/github/repo-size/victorbalssa/abacus?style=for-the-badge)
![licence](https://img.shields.io/github/license/victorbalssa/abacus?style=for-the-badge)
![stars](https://img.shields.io/github/stars/victorbalssa/abacus?style=for-the-badge)
[![sdk](https://img.shields.io/badge/EXPO-SDK-purple?style=for-the-badge&label=EXPO%20SDK)](https://www.npmjs.com/package/expo)
[![pr](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](http://makeapullrequest.com)
[![sponsor](https://img.shields.io/github/sponsors/victorbalssa?style=for-the-badge&color=ff69b4)](https://github.com/sponsors/victorbalssa)

  </sup>
</div>

---

### 🎙 Introduction

[Firefly III](https://github.com/firefly-iii/firefly-iii) mobile application to manage your self-hosted Firefly III from
your mobile.

Support for iPhone, iPad, Android Phone and Android Tablet.

On iOS, Tokens are stored in [**iOS Keychains**](https://developer.apple.com/documentation/security/keychain_services).

On Android, Tokens are stored in [**SharedPreferences**](https://developer.android.com/training/data-storage/shared-preferences), encrypted with [**Android's Keystore system**](https://developer.android.com/training/articles/keystore.html).

No external API calls nor Analytics API, not even sentry / crashlytics.

---

### 📱 Features

## [🏁 Roadmap](https://github.com/users/victorbalssa/projects/2/views/1)

| Feature                      | Available |
|------------------------------|:---------:|
| Oauth2 authentication        |     ✅     |
| Asset accounts history chart |     ✅     | 
| Transactions (create, list)  |     ✅     |
| Net worth                    |     ✅     |
| Balance                      |     ✅     |
| Earned                       |     ✅     |
| Time range selector          |     ✅     |
| Budgets                      |     ✅     |
| Categories                   |     ✅     |
| Translations                 |   ✅(@carvalholeo)    |
| Piggy bank                   |     ✅     |

---

### 📡 Technologies

- __Expo SDK__ Framework and a Platform for universal React applications. [docs.expo.io](https://docs.expo.io/)
- __Routing and navigation__ React Navigation
  V6. [https://reactnavigation.org/docs](https://reactnavigation.org/docs/getting-started)
- __Tests__ on simulator/emulator before each EAS build with [@wix/Detox](https://github.com/wix/Detox)
- __Store arch__
    - Rematch core [@rematch/core](https://github.com/rematch/rematch)
    - Loading plugin [@rematch/loading](https://rematchjs.org/docs/plugins/loading)
    - Persist plugin [@rematch/persist](https://rematchjs.org/docs/plugins/persist)
- __Linting__
    - Airbnb's Linting : [https://github.com/airbnb/javascript](https://github.com/airbnb/javascript)

---

### 📖 Docs

- [Contributing to this project](.github/CONTRIBUTING.md)
- [Understanding the file structure](.github/FILE.md)
- [Need help with Authentication?](.github/HELP.md)
- [ReactNative.dev](https://reactnative.dev)
