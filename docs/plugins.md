# Writing a plugin

A plugin adds components aicd can use by name from `.aicd.yaml`: CI adapters, LLM providers, issue trackers,
metrics sources, deployers, notifiers or state stores. It depends on `@aicd/plugin-sdk` only (plugin API
version 1, stable for the whole 1.x line).

## 1. The manifest

```ts
// index.ts of the package "aicd-plugin-pagerduty"
import {definePlugin, PLUGIN_API_VERSION, type Notifier} from "@aicd/plugin-sdk";

class PagerDutyNotifier implements Notifier {
    readonly name = "pagerduty";
    constructor(
        private readonly routingKey: string,
        private readonly fetchImpl: typeof fetch
    ) {}
    async send(notification) {
        const response = await this.fetchImpl("https://events.pagerduty.com/v2/enqueue", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                routing_key: this.routingKey,
                event_action: "trigger",
                payload: {summary: notification.title, severity: notification.severity, source: "aicd"}
            })
        });
        if (!response.ok) throw new Error(`PagerDuty: HTTP ${response.status}`);
    }
}

export default definePlugin({
    name: "aicd-plugin-pagerduty",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    provides: {
        notifiers: [
            {
                name: "pagerduty",
                create: (config, {env, fetch}) => {
                    const key = env[String(config.routing_key_env ?? "PAGERDUTY_ROUTING_KEY")];
                    if (!key) throw new Error("PagerDuty routing key is not set");
                    return new PagerDutyNotifier(key, fetch);
                }
            }
        ]
    },
    actions: ["notify"]
});
```

Rules: read secrets from environment variables named in the configuration, never from configuration values;
use the injected `fetch`; throw clear errors; never write to stdout (it carries command output).

## 2. Use it

```yaml
plugins: [aicd-plugin-pagerduty]
integrations:
    notifiers:
        - type: pagerduty
          routing_key_env: PAGERDUTY_ROUTING_KEY
```

The package must be installed in the repository (`npm i -D aicd-plugin-pagerduty`). Organisations can restrict
plugins with `plugins.allowed` in their policies.

## 3. Test it with the conformance kit

```ts
import {checkPluginManifest, checkStateStore, checkCIProvider, checkLLMProvider} from "@aicd/plugin-sdk/testing";
import plugin from "../src/index.js";

test("manifest", () => expect(checkPluginManifest(plugin)).toEqual([]));
// state stores: expect(await checkStateStore(() => createEmptyStore())).toEqual([]);
```

Each check returns the list of failures, so it works with any test runner.

## Compatibility

`apiVersion` must equal the `PLUGIN_API_VERSION` of the aicd you run; a plugin built for another major version is
refused at load time. Changes to `@aicd/plugin-sdk` are tracked in `packages/plugin-sdk/api-report.d.ts`;
breaking ones only happen in a new major version, with an ADR.
