# Web previews and Impeccable Live

Gestalt Mobile can publish a local development server to a browser tab from an
active chat. Your existing passkey login grants access to the preview over
HTTPS. The gateway forwards app requests and WebSockets, including live reload
from dev servers such as Vite.

## Configure the preview hostname

Use two HTTPS hostnames on the same reverse proxy. Keep `--public-origin` on the
hostname already enrolled for Mobile. Choose a sibling hostname or a separate
domain for the preview, since Mobile rejects its own hostname and subdomains of
that hostname as preview origins. This gives the app a separate browser origin.

For example, point both DNS names at Caddy. This example runs Mobile on port
`4000` and uses the default gateway port `8080`.

```caddyfile
relay.example.org {
    reverse_proxy 127.0.0.1:4000
}

preview.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

Reload Caddy after adding the preview hostname. Use your existing certificate
setup or let Caddy obtain the certificate. The dev server and gateway can run
under a regular user account. Editing and reloading a system-managed Caddy
service may require administrator access.

To enable previews while Mobile is running, create
`~/.codex-gestalt/gestalt-mobile/preview.json` on the Mobile host:

```json
{
  "relayOrigin": "https://relay.example.org",
  "origin": "https://preview.example.org",
  "gatewayPort": 8080,
  "targetPort": 5173
}
```

Use the exact public HTTPS origins. The account that runs Mobile must own this
file, and only that account may write to it. Keep it outside agent-controlled
workspaces. Reload the Mobile page and open the same chat. Mobile reads the file
when the page loads and when you open a preview. Passkey authentication must
be enabled.

You can also set defaults in the Mobile startup command. For example:

```bash
gestalt mobile --host 127.0.0.1 --port 4000 \
  --public-origin https://relay.example.org \
  --preview-origin https://preview.example.org
```

Both origin flags take the exact external HTTPS origin, including any
non-default port. Use `--preview-gateway-port` to set a different startup
listener for Caddy.
Settings in the host file for this relay origin override the startup defaults.
Removing the file restores the startup defaults on the next page load.

### Run multiple Mobile instances on one host

Give each instance a distinct Mobile listener, preview hostname and gateway
port. When serving different apps at the same time, also choose distinct dev
server ports. Each Caddy preview site forwards to its instance's
`gatewayPort`. For example, for a second instance:

```caddyfile
preview-two.example.org {
    reverse_proxy 127.0.0.1:8081
}
```

Point that hostname's DNS at Caddy and reload Caddy. In the Mobile account's
`preview.json`, set `origin` to `https://preview-two.example.org`,
`gatewayPort` to `8081`, `targetPort` to a free dev server port such as
`5174`, and `relayOrigin` to that Mobile instance's exact HTTPS origin.

Each OS account has its own settings file and passkey store. Instances under
one account share the enrolled Mobile hostname. If those instances use
different HTTPS ports, put one settings object per exact `relayOrigin` in a
JSON array in that account's `preview.json`.

## Start the app and open a preview

Run the app's dev server separately on the Mobile host. The gateway targets
`127.0.0.1:5173` by default. For another port, change `targetPort` in the host
file. You can also use `--preview-target-port <port>` as a startup default.
Choose an unprivileged port distinct from the Mobile and gateway ports.
Caddy points at the gateway port. You can change the dev server port without
editing Caddy. When Mobile applies a new origin, gateway port or target port,
it closes the old preview and revokes its browser access. Open the preview
again from the same chat.

For Vite, allow the exact preview hostname and pin the port so it stays in sync
with Mobile.

```bash
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=preview.example.org \
  npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

1. Sign in to Mobile and open an active chat.
2. Choose **Configuration → Open preview**. The menu shows the action once
   Mobile reports that the gateway is available for an active chat. The app
   opens in a new tab with a preview cookie scoped to that hostname.
3. Choose **Configuration → Stop preview** when you're done.

Mobile publishes one configured app for one chat at a time. Mobile accepts the
preview cookie for up to one hour, while the associated login remains valid.
Stopping the preview or closing or forgetting its chat revokes access and
closes active streams. Restarting Mobile clears the publication. The gateway
blocks preview service workers.

## Use the Impeccable commands

When the chat's skill selection enables Impeccable, type `/impeccable` in the
composer to open the action picker. Select an action and send it, or type the
full command directly. For example, `/impeccable audit settings page` names a
target. With `/impeccable audit`, the agent infers the target from the chat.

| Group             | Actions                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Build             | `shape [feature]`, `document`, `extract [target]`                                                                        |
| Evaluate          | `critique [target]`, `audit [target]`                                                                                    |
| Refine            | `polish [target]`, `bolder [target]`, `quieter [target]`, `distill [target]`, `harden [target]`, `onboard [target]`      |
| Enhance           | `animate [target]`, `colorize [target]`, `typeset [target]`, `layout [target]`, `delight [target]`, `overdrive [target]` |
| Fix               | `clarify [target]`, `adapt [target]`, `optimize [target]`                                                                |
| Browser iteration | `live`                                                                                                                   |

### Start and finish a Live session

1. With the dev server running, send `/impeccable live` in the active chat.
2. Mobile opens a preview tab with permission to use the Live editor. The agent
   starts or reuses Impeccable's loopback helper in the chat workspace and polls
   it for your actions.
3. Use the picker in the preview tab to select an element and try variants.
   Accept a variant to apply it to the project source.
4. Select **Exit** in Impeccable to finish the agent's Live polling loop.
   Use **Stop preview** in Mobile to revoke browser access and close its event
   streams.

The Live picker and event stream use the existing preview hostname through the
gateway. The same Caddy site block serves the app and Live. **Open preview**
opens a normal interactive app tab, and `/impeccable live` adds access to the
editor.

## Troubleshoot

| Symptom                                                | What to check                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caddy returns `502` on the preview hostname            | Reload Mobile and check that Caddy points to Mobile's configured loopback gateway port.                                                                                         |
| The preview reports that the app server is unavailable | Start the dev server on loopback and check that its port matches the configured target port.                                                                                    |
| The app rejects the preview host or live reload fails  | Allow the exact preview hostname in the dev server and confirm the proxy forwards WebSocket upgrades.                                                                           |
| Mobile reports that a preview is already in use        | Stop the preview from the chat that opened it, then try again.                                                                                                                  |
| The Live picker is missing                             | Open the app with `/impeccable live`. Confirm the agent started the helper in the chat workspace and that the app's development CSP allows same-origin scripts and connections. |

[Back to Mobile setup](../README.md#passkey-deployment-and-operating-limits)
