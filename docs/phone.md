# Use QuietApply from your phone

Answer questions, approve reviews and finish the jobs QuietApply handed back, from the couch. The dashboard stays on your Mac; your phone reaches it through [Tailscale](https://tailscale.com), a private network that only your own devices join.

## Why Tailscale

- **Nothing is public.** The dashboard keeps listening on `127.0.0.1` only. `quietapply phone` uses [Tailscale Serve](https://tailscale.com/kb/1312/serve), which shares it inside your tailnet. It never uses Funnel, the feature that publishes to the whole internet, and checks that after turning Serve on.
- **No router settings, no port forwarding, no password to invent.** It works from mobile data too.
- **Real HTTPS.** Tailscale issues a certificate for your Mac's `*.ts.net` name, so the phone can install QuietApply as an app.
- **You decide who is in.** Serve adds the visitor's Tailscale login to each request (and removes any copy a client tries to send). QuietApply lets in only the logins in `phone.allowedLogins`; with none listed it lets nobody in, so another person or device on your tailnet gets a "403 not allowed".

## Steps

1. **Install Tailscale on the Mac** ([download](https://tailscale.com/download), or `brew install --cask tailscale`) and sign in. Free personal plans work.
2. **Install Tailscale on your phone** and sign in with the same account.
3. In the [admin console, DNS page](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS Certificates** (one time).
4. Start the dashboard and switch phone access on:

   ```bash
   quietapply dashboard        # keep it running (or use your usual way of starting it)
   quietapply phone
   ```

   It prints an address like `https://my-mac.tail1234.ts.net:8443`.
5. Open that address on the phone (Tailscale must be on). Then **Share → Add to Home Screen** (iPhone) or **Install app** (Android Chrome): QuietApply opens full screen like an app.

If Tailscale is missing or signed out, `quietapply phone` prints these steps instead of doing anything.

To switch it off: `quietapply phone off`. That removes only QuietApply's entry; your other Tailscale Serve settings are not touched.

## What it changes on your Mac

`quietapply phone` runs `tailscale serve --bg --https=<port> http://127.0.0.1:4777`.

- **Port:** `phone.httpsPort`, 8443 by default. Tailscale allows 443, 8443 and 10000. If the port already serves something else (maybe another of your apps), QuietApply moves to the next free one and never replaces it.
- **Config:** it saves `phone.host` (your Mac's tailnet name) and, if the list is empty, your own Tailscale login in `phone.allowedLogins`, in `~/.quietapply/config.yaml`:

  ```yaml
  phone:
    host: my-mac.tail1234.ts.net
    httpsPort: 8443
    allowedLogins: [you@example.com]   # add a second login to let someone else in
  ```

## How requests are checked

| Request | Allowed when |
|---|---|
| `127.0.0.1:4777` or `localhost:4777` (this Mac) | always, as before |
| `<phone.host>` over the tailnet | the `Tailscale-User-Login` header is in `phone.allowedLogins`, and a write carries the `x-quietapply` header and an `Origin` of `https://<phone.host>` |
| any other host name | never (blocks DNS-rebinding) |

Serve talks to QuietApply from `127.0.0.1`, so the identity header is only trusted for the exact tailnet name you set. Tagged devices (servers) carry no identity header, so they are refused too.

## Troubleshooting

- **"HTTPS not enabled"**: step 3 above.
- **Page does not load**: is `quietapply dashboard` running, and is Tailscale on on the phone? `tailscale serve status` shows what is served.
- **403 on the phone**: your Tailscale login is not in `phone.allowedLogins`. Open `~/.quietapply/config.yaml` and add it.
- **Funnel**: never turned on. If you ever see your dashboard listed as "Funnel on" in `tailscale serve status`, run `quietapply phone off`.

Back to the [README](../README.md) · [How it works](how-it-works.md)
