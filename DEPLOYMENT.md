# Deploying to Azure

This app is a single long-running Node HTTP server (`src/server/index.ts`), containerized
and deployed to **Azure App Service (Linux, custom container)** — the same pattern
`calendar-scheduling` uses (see its `.github/workflows/deploy-production.yml`): build with
Docker, push to **Azure Container Registry**, deploy with `azure/webapps-deploy` and a
publish profile. Unlike that app, lunacal-mcp needs no runtime placeholder-substitution
entrypoint — it reads `process.env` directly, so plain App Settings are enough.

## Important constraint: run exactly 1 instance

`src/server/oauthBroker.ts` keeps all OAuth state (pending logins, issued tokens) **in
memory**. If App Service scales this out to more than one instance, requests can land on
an instance that never saw the matching `/authorize` or `/token` step, breaking auth
non-deterministically. Do not enable autoscale / multiple instances for this app until
that state is moved to a shared store (e.g. Redis).

## One-time Azure setup

```bash
az login

RESOURCE_GROUP=lunacal-mcp-rg
LOCATION=eastus
PLAN_NAME=lunacal-mcp-plan
APP_NAME=lunacal-mcp          # must be globally unique; becomes <APP_NAME>.azurewebsites.net

az group create --name $RESOURCE_GROUP --location $LOCATION

# B1 (or higher) is the smallest tier that supports "Always On", which this app needs
# so idle-timeout restarts don't silently wipe in-memory OAuth state.
az appservice plan create \
  --name $PLAN_NAME \
  --resource-group $RESOURCE_GROUP \
  --is-linux \
  --sku B1 \
  --number-of-workers 1

ACR_NAME=newlunacalcontainer   # reuse the org's existing registry, as calendar-scheduling does

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
  LUNACAL_WEBAPP_URL="https://app.lunacal.ai" \
  LUNACAL_OAUTH_CLIENT_ID="<from your .env>" \
  LUNACAL_OAUTH_CLIENT_SECRET="<from your .env>"
```

`WEBSITES_PORT` tells App Service which port the container listens on — it must match
the `PORT` the app itself reads (see `Dockerfile`, defaults to `3939`).

### Registry access (Azure Container Registry)

Like the other Lunacal apps, images go to the org's ACR (`newlunacalcontainer.azurecr.io`),
not GHCR. Point App Service at it with ACR's admin credentials:

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

```bash
az webapp deployment list-publishing-profiles \
  --name $APP_NAME --resource-group $RESOURCE_GROUP --xml > publish-profile.xml
```

Copy the file's contents into a GitHub repo secret named `AZURE_WEBAPP_PUBLISH_PROFILE`
(Settings → Secrets and variables → Actions). Also update `AZURE_WEBAPP_NAME` in
`.github/workflows/azure-deploy.yml` if you used a different `$APP_NAME`. Delete
`publish-profile.xml` locally afterward — it contains credentials.

## Deploying

Push to `main` and the `azure-deploy` workflow builds the Docker image, pushes it to
ACR, and points the App Service at the new image tag. To deploy manually instead:

```bash
az acr login --name $ACR_NAME
docker build -t $ACR_NAME.azurecr.io/lunacal-mcp-image:latest .
docker push $ACR_NAME.azurecr.io/lunacal-mcp-image:latest
az webapp restart --name $APP_NAME --resource-group $RESOURCE_GROUP
```

## Verifying

```bash
curl https://$APP_NAME.azurewebsites.net/.well-known/oauth-protected-resource
```

Should return the JSON metadata document, not a 404/502.
