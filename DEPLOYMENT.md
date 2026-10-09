# Deploying to Azure

This app is a single long-running Node HTTP server (`src/server/index.ts`), containerized
and deployed to **Azure App Service (Linux, custom container)** — the same pattern
`calendar-scheduling` uses (see its `.github/workflows/deploy-production.yml`): build with
Docker, push to **Azure Container Registry**, deploy with `azure/webapps-deploy` and a
publish profile. Unlike that app, lunacal-mcp needs no runtime placeholder-substitution
entrypoint — it reads `process.env` directly, so plain App Settings are enough.

## Current deployment

| | |
|---|---|
| Azure account | Lunacal org tenant ("Lunacal Private Limited", subscription "Microsoft Azure Sponsorship") |
| URL | `https://lunacal-mcp-app.azurewebsites.net` |
| Resource group | `lunacal-mcp-app_group` (Canada Central — same region as `lunacal-test-app` and the shared ACR) |
| App Service plan | `lunacal-mcp-app-plan` (Linux, B1) |
| Container registry | shared `newlunacalcontainer.azurecr.io`, repo `lunacal-mcp-image` |
| Pointed at | `https://testing.lunacal.ai` (set `LUNACAL_WEBAPP_URL` to change) |

A separate, earlier deployment also exists in a personal Azure subscription
(`lunacal-mcp.azurewebsites.net`, resource group `lunacal-mcp-rg`, its own dedicated ACR
`lunacalmcpacr`) — kept running for now as a fallback. Delete it
(`az group delete --name lunacal-mcp-rg`) once the org deployment above is confirmed
working end-to-end with a real MCP client.

## Important constraint: run exactly 1 instance

`src/server/oauthBroker.ts` keeps all OAuth state (pending logins, issued tokens) **in
memory**. If App Service scales this out to more than one instance, requests can land on
an instance that never saw the matching `/authorize` or `/token` step, breaking auth
non-deterministically. Do not enable autoscale / multiple instances for this app until
that state is moved to a shared store (e.g. Redis).

## One-time Azure setup (for provisioning a fresh copy)

```bash
az login   # must be the Lunacal org account to reuse the shared ACR below

RESOURCE_GROUP=lunacal-mcp-app_group
LOCATION=canadacentral
PLAN_NAME=lunacal-mcp-app-plan
APP_NAME=lunacal-mcp-app     # must be globally unique; becomes <APP_NAME>.azurewebsites.net
ACR_NAME=newlunacalcontainer # the org's existing shared registry

az group create --name $RESOURCE_GROUP --location $LOCATION

# B1 (or higher) is the smallest tier that supports "Always On", which this app needs
# so idle-timeout restarts don't silently wipe in-memory OAuth state.
az appservice plan create \
  --name $PLAN_NAME \
  --resource-group $RESOURCE_GROUP \
  --is-linux \
  --sku B1 \
  --number-of-workers 1

az webapp create \
  --name $APP_NAME \
  --resource-group $RESOURCE_GROUP \
  --plan $PLAN_NAME \
  --deployment-container-image-name $ACR_NAME.azurecr.io/lunacal-mcp-image:latest

az webapp config set --name $APP_NAME --resource-group $RESOURCE_GROUP --always-on true
az webapp update --name $APP_NAME --resource-group $RESOURCE_GROUP --https-only true
```

### App settings (environment variables)

```bash
az webapp config appsettings set --name $APP_NAME --resource-group $RESOURCE_GROUP --settings \
  WEBSITES_PORT=3939 \
  PORT=3939 \
  LUNACAL_MCP_PUBLIC_URL="https://$APP_NAME.azurewebsites.net" \
  LUNACAL_WEBAPP_URL="https://testing.lunacal.ai" \
  LUNACAL_OAUTH_CLIENT_ID="<PlatformOAuthClient id>" \
  LUNACAL_OAUTH_CLIENT_SECRET="<PlatformOAuthClient secret>"
```

`WEBSITES_PORT` tells App Service which port the container listens on — it must match
the `PORT` the app itself reads (see `Dockerfile`, defaults to `3939`). After changing
settings, restart (`az webapp restart ...`) and re-check the verification curl below —
a stale container instance can keep serving the old config for a bit after a settings
change alone.

### Registry access (Azure Container Registry)

Images go to the org's shared ACR (`newlunacalcontainer.azurecr.io`), not GHCR. Point App
Service at it with the registry's admin credentials:

```bash
az acr credential show --name $ACR_NAME --query "{user:username,pass:passwords[0].value}"

az webapp config container set \
  --name $APP_NAME --resource-group $RESOURCE_GROUP \
  --docker-registry-server-url https://$ACR_NAME.azurecr.io \
  --docker-registry-server-user <username from above> \
  --docker-registry-server-password <password from above>
```

Add the same three values as GitHub repo secrets (Settings → Secrets and variables →
Actions) so the workflow can push there too:

- `ACR_LOGIN_SERVER` = `newlunacalcontainer.azurecr.io`
- `ACR_USERNAME` / `ACR_PASSWORD` = the values from `az acr credential show` above

If you'd rather isolate this service from the shared registry, create a dedicated one
instead (`az acr create --name <new-name> --resource-group $RESOURCE_GROUP --sku Basic
--admin-enabled true`) and use its login server/credentials the same way.

### Get the publish profile for CI/CD

`az webapp deployment list-publishing-profiles --xml` redacts the credential fields in
its own output (a real Azure CLI security feature, not something you can pass a flag
around) — don't rely on piping it to a file from a script. Get the real file from the
**Azure Portal** instead: Web App → Overview → **Download publish profile**. Paste that
file's full contents as the `AZURE_WEBAPP_PUBLISH_PROFILE` GitHub repo secret. Also keep
`AZURE_WEBAPP_NAME` in `.github/workflows/azure-deploy.yml` in sync with `$APP_NAME`.

## Deploying

Push to `main` and the `azure-deploy` workflow builds the Docker image, pushes it to
ACR, and points the App Service at the new image tag. To deploy manually instead:

```bash
az acr build --registry $ACR_NAME --image lunacal-mcp-image:latest .
az webapp restart --name $APP_NAME --resource-group $RESOURCE_GROUP
```

(`az acr build` builds in the cloud and pushes directly — no local `docker login`/`push`
needed, and no local Docker Desktop required either.)

## Verifying

```bash
curl https://$APP_NAME.azurewebsites.net/.well-known/oauth-protected-resource
curl https://$APP_NAME.azurewebsites.net/.well-known/oauth-authorization-server
curl -o /dev/null -w "%{http_code}\n" https://$APP_NAME.azurewebsites.net/mcp   # expect 401, not 404/502
```

The first two should return JSON metadata documents whose URLs match `$APP_NAME` (not
`localhost` — that means the container hasn't picked up `LUNACAL_MCP_PUBLIC_URL` yet,
usually fixed by one more restart). None of this proves the OAuth exchange with Lunacal
itself works — only a real MCP client walking through login against
`LUNACAL_WEBAPP_URL` confirms that.
