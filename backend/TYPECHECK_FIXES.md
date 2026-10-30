# Typecheck fixes

This revision addresses the TypeScript errors reported from the current codebase.

## Fixed

- `ai-care-plan.ts`: validate `draft.plan` before reading `goals` or `tasks`.
- `app.ts`: use the named `pinoHttp` export to match the installed `pino-http` typings.
- `queues.ts`: use the module namespace and its default Redis constructor to work with the installed `ioredis` ESM/CJS typings.
- `routes.ts`: normalize Express route parameters through a strict `routeParam()` helper instead of unsafe casts.
- `routes.ts`: return a controlled `INVALID_CARE_PLAN_DRAFT` response when an incomplete draft reaches approval.

## Validation

The uploaded project does not contain `node_modules`, and the configured package registry in this environment returns 404 for the project's npm dependencies, so a full dependency-backed `npm run typecheck` cannot be executed here.

Run locally after installing dependencies:

```bash
npm ci
npm run typecheck
npm run build
```

Do not suppress new TypeScript errors with `any` or `@ts-ignore`.
