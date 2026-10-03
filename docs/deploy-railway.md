# Railway deployment runbook — owner gated

Do not execute this runbook until local acceptance is complete and the owner approves deployment. The repository includes configuration only; no service has been deployed.

1. Create one Railway project.
2. Add PostgreSQL. Use its private service connection for the API; do not expose a trust-authenticated development database.
3. Add the FastAPI service, using repository-root build context and `services/api/Dockerfile`. Select `infra/railway.toml` as its configuration file. Only API code is copied into the image; demo fixtures, game files and workspace tools are excluded.
4. Generate a Railway HTTPS domain.
5. The current Railway service domain is `https://ii-engine-api-production.up.railway.app`. Set `BACKEND_PUBLIC_URL` to that origin and `DISCORD_OAUTH_REDIRECT_URI=https://ii-engine-api-production.up.railway.app/v1/auth/discord/callback`. Set `FRONTEND_ORIGIN=http://tauri.localhost` for the packaged Tauri webview and verify it during Windows acceptance testing.
6. Add secrets directly through Railway Variables using `services/api/.env.example` as the variable-name reference. Use independent high-entropy signing and refresh-pepper values. `APP_ENV=production` rejects missing required configuration. Do not set secrets through build arguments. For AI, set `SILICONFLOW_API_KEY`, `AI_MODEL=Qwen/Qwen2.5-7B-Instruct`, and `AI_BASE_URL=https://api.siliconflow.com/v1` (use `./scripts/setup-siliconflow-railway.sh` when the Railway CLI is linked).
7. Run `alembic upgrade head` as the pre-deploy command; it is declared in the Railway configuration. Take a managed database backup before future schema changes.
8. Deploy only after approval, then verify `/health/live` and `/health/ready` over HTTPS. Readiness must be checked again against the expected migration head before promotion.
9. Add the final exact callback URL in Discord and run the controlled end-to-end account/role checks in `discord-setup.md`.
10. Set budget, database-storage and usage alerts. Configure PostgreSQL automated backups and their retention. Restore into an isolated database, run `alembic current`, validate row counts/foreign keys and smoke-test authentication with test accounts before declaring disaster recovery ready. Never overwrite the active production database to test a restore.

Place shared request limits at the trusted edge before scaling workers. The API includes bounded per-process limits, but those are not a shared distributed rate limiter. Configure proxy trust explicitly; do not trust arbitrary forwarded IP headers. Disable URL/query-string access logging for OAuth callback traffic. Routine application logs contain only request IDs and status codes.

Outstanding release gates: native Windows build/runtime verification, approved complete baseline, signed publisher configuration, retention/erasure procedures, legal review and real-provider tests. This runbook does not remove those gates.
