# pi-zcode

Unofficial ZCode browser-login providers for Pi, with separate BigModel (China) and Z.ai (international) Coding Plan routes.

[中文说明](README.zh-CN.md)

## Install

```sh
pi install git:github.com/0x1f/pi-zcode
```

Restart Pi or run `/reload`, then choose a login:

```text
/login zcode-cn
/login zcode-intl
```

Complete authorization on the official browser page, then select a model with `/model`. To try the package without persistent installation:

```sh
pi -e git:github.com/0x1f/pi-zcode
```

**The similarly named npm package is unrelated.** Install this project from its GitHub repository, not `npm:pi-zcode`. This package is marked private to prevent accidental npm publication.

## Authentication and consent

- Browser login only: no manual API-key prompt, environment-key fallback, browser-cookie access, or desktop credential import. Existing API-key users should use Pi's built-in providers instead.
- After authorization, choose an organization/project when needed. Only the selected project's key named `pi-zcode` is reused.
- Creating a new long-lived inference key requires explicit confirmation. The default choice cancels; creation is never retried automatically. A failed request may still have created a server-side key, so check the official console after an interruption.
- Pi stores the derived inference key in a provider-scoped OAuth credential record. Temporary account/business tokens are not persisted. No unsupported refresh endpoint is invented; invalid credentials require another browser login.
- **`/logout` removes local credentials only.** Revoke the server-side key in the official console when no longer needed. Pi's credential file is sensitive storage, not an OS keychain.
- Passwords and CAPTCHA stay on the official site. This extension does not solve challenges, claim benefits, or run background sign-in tasks.

## Inference and diagnostics

Uses Pi's native OpenAI Completions transport, including system prompts, reasoning, tool turns, advertised image input, and cancellation. Providers never fall back across regions, to regular pay-as-you-go endpoints, or to free plans.

```text
/zcode-safe cn status
/zcode-safe intl status
/zcode-safe cn refresh
/zcode-safe intl refresh
/zcode-safe cn quota
/zcode-safe intl quota
/zcode-safe cancel
```

Status is local; catalog and quota queries are read-only. Failed catalog refreshes retain the previous successful catalog. Unknown quota is not zero, and a displayed zero token cost does not mean the server is free. Model capabilities come only from Pi's known catalog.

**Free Start Plan inference is not supported or verified.** Use the official ZCode client to claim benefits manually. `/zcode-claim` is not included.

## Verification and limits

Tested against Pi 0.85.0 and Node 26.8.1. The 14 offline checks cover browser flows, credential isolation, consent, cancellation, response validation, catalog races, quotas, and native streaming. Strict TypeScript checking passes with third-party declaration checking skipped.

```sh
node --test test.ts
node smoke.mjs /absolute/path/to/pi/dist/bundle/cli.js --ui
```

Direct Node tests require the matching Pi peer packages. Smoke tests require Linux user/network namespaces (`unshare`); `--ui` also requires Python 3. The actual bundled CLI runs without network access, browser launchers are stubbed, and both login menus and default-cancel consent paths are checked. Isolation failures never fall back to live networking.

Full real-account authorization, real key provisioning, subscription access, inference and billing remain unverified. Integration depends on ZCode's CLI service behavior and may stop working if that service changes. Passing mocked UI tests is not proof of successful live login.
