# STAC Browser Helm Chart

A Helm chart that deploys [STAC Browser](https://github.com/radiantearth/stac-browser)
— a static Vue single-page app served by nginx — onto Kubernetes. Intended to be
deployed via Argo CD, but usable with plain `helm install` too.

## How it works

The container image is a two-stage build: `npm run build` produces static files,
which an unprivileged nginx serves on port **8080**. At container startup an
entrypoint reads every `SB_*` environment variable and writes a
`runtime-config.js` file, so most STAC Browser options are configured at **runtime**
via this chart's `config` block — no image rebuild needed.

A few options are **build-time only** (`pathPrefix`, `historyMode`, `SB_CONFIG`).
They are baked into the image and **cannot** be set through this chart; changing
them requires rebuilding and re-pushing the image.

## Values

### Image

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `image.repository` | string | `ghcr.io/eurac/stac-browser` | Image repository. Point at the registry where your fork's image is pushed. |
| `image.tag` | string | `""` | Image tag. Falls back to the chart `appVersion` when empty. |
| `image.pullPolicy` | string | `IfNotPresent` | Image pull policy. |
| `imagePullSecrets` | list | `[]` | Secrets for pulling from a private registry, e.g. `[{name: regcred}]`. |

### STAC Browser configuration (`config`)

Every key under `config` is exported as an `SB_<key>` environment variable and
turned into `runtime-config.js` at startup. **Key names must match the option
names** in [`config.schema.json`](../config.schema.json) /
[`config.js`](../config.js). All values are passed as strings; the entrypoint
converts them by type:

| Value type | How to write it in `values.yaml` | Example |
| --- | --- | --- |
| string | plain string | `catalogTitle: "EURAC STAC"` |
| boolean | `"true"` / `"false"` | `allowExternalAccess: "true"` |
| array | comma-separated string | `allowedDomains: "https://a.org,https://b.org"` |
| object | raw JSON string | `requestHeaders: '{"Authorization":"Bearer x"}'` |

Commonly set options:

| `config` key | Type | Description |
| --- | --- | --- |
| `catalogUrl` | string | STAC catalog/API URL to open by default. Leave unset to show the URL entry screen. |
| `catalogTitle` | string | Title shown in the header. |
| `allowExternalAccess` | boolean | Allow browsing catalogs other than `catalogUrl`. Must be `"true"` if `catalogUrl` is unset. |
| `allowedDomains` | array | Extra domains allowed for requests (comma-separated). |
| `detectLocaleFromBrowser` | boolean | Auto-pick UI language from the browser. |
| `locale` / `fallbackLocale` | string | Default and fallback UI language. |
| `requestHeaders` | object | Extra HTTP headers sent with catalog requests (JSON). |
| `requestQueryParameters` | object | Extra query params added to catalog requests (JSON). |
| `cardViewMode` | string | `cards` or `list`. |

> See [`config.schema.json`](../config.schema.json) for the full list of options
> and their allowed values.

> **Build-time only — not settable here:** `pathPrefix`, `historyMode`,
> `SB_CONFIG`. Rebuild the image to change them, and set `probePath` (below) to
> match a non-root `pathPrefix`.

Anything not covered by `config` can be added with:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `extraEnv` | list | `[]` | Extra env vars passed verbatim (`{name, value}` or `valueFrom`). |
| `envFrom` | list | `[]` | Env sourced from ConfigMaps/Secrets. |

### Workload

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `replicaCount` | int | `1` | Pod replicas (ignored when `autoscaling.enabled`). |
| `containerPort` | int | `8080` | Port nginx listens on. Do not change unless the image is rebuilt. |
| `probePath` | string | `/` | HTTP path for liveness/readiness probes. Must match the served `pathPrefix`. |
| `resources.requests` | map | `cpu: 10m, memory: 32Mi` | Resource requests. |
| `resources.limits` | map | `memory: 128Mi` | Resource limits. |
| `podAnnotations` | map | `{}` | Annotations added to pods. |
| `podLabels` | map | `{}` | Labels added to pods. |
| `nodeSelector` | map | `{}` | Node selector. |
| `tolerations` | list | `[]` | Tolerations. |
| `affinity` | map | `{}` | Affinity rules. |

### Security

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `podSecurityContext` | map | `runAsNonRoot: true, runAsUser/Group: 101, seccompProfile: RuntimeDefault` | Pod security context (nginx-unprivileged runs as uid 101). |
| `securityContext` | map | `allowPrivilegeEscalation: false, capabilities.drop: [ALL]` | Container security context. `readOnlyRootFilesystem` is left off because the entrypoint writes `runtime-config.js` into the web root. |
| `serviceAccount.create` | bool | `true` | Create a dedicated ServiceAccount. |
| `serviceAccount.name` | string | `""` | ServiceAccount name (generated when empty). |
| `serviceAccount.annotations` | map | `{}` | ServiceAccount annotations. |

### Service & Ingress

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `service.type` | string | `ClusterIP` | Service type. |
| `service.port` | int | `80` | Service port (targets container port 8080). |
| `ingress.enabled` | bool | `false` | Create an Ingress. |
| `ingress.className` | string | `""` | Ingress class name (e.g. `nginx`). |
| `ingress.annotations` | map | `{}` | Ingress annotations. |
| `ingress.hosts` | list | `[{host: stac-browser.example.org, paths: [{path: /, pathType: Prefix}]}]` | Host/path rules. |
| `ingress.tls` | list | `[]` | TLS config, e.g. `[{secretName: tls, hosts: [stac-browser.example.org]}]`. |

### Autoscaling

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `autoscaling.enabled` | bool | `false` | Create a HorizontalPodAutoscaler. |
| `autoscaling.minReplicas` | int | `1` | Minimum replicas. |
| `autoscaling.maxReplicas` | int | `5` | Maximum replicas. |
| `autoscaling.targetCPUUtilizationPercentage` | int | `80` | Target average CPU %. |
| `autoscaling.targetMemoryUtilizationPercentage` | int | _(unset)_ | Target average memory %. Set to enable. |

### Naming

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `nameOverride` | string | `""` | Override the chart name in resource names. |
| `fullnameOverride` | string | `""` | Override the full release name. |

## Example overlay

```yaml
# values.prod.yaml
image:
  repository: ghcr.io/eurac/stac-browser
  tag: "5.0.0-rc.1"

config:
  catalogUrl: "https://stac.eurac.edu/v1/"
  catalogTitle: "EURAC STAC"
  allowExternalAccess: "false"
  allowedDomains: "https://stac.eurac.edu"

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: browser.stac.eurac.edu
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: stac-browser-tls
      hosts:
        - browser.stac.eurac.edu
```
