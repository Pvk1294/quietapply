import { useEffect, useState } from "react";
import { api, type PhoneInfo } from "../api";
import { copyText, toast, usePoll } from "../ui";

const PHONE_DOCS = "https://github.com/Pvk1294/quietapply/blob/main/docs/phone.md";

/** Settings → Phone access: this dashboard on your phone through Tailscale, private to your tailnet. */
export function PhoneCard() {
  const { data, reload } = usePoll(api.phone, 30000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [logins, setLogins] = useState<string>();
  const loaded = !!data;
  // The tour links here with #/settings?phone.
  useEffect(() => {
    if (!loaded) return;
    const go = () => {
      if (location.hash.includes("?phone"))
        setTimeout(() => document.getElementById("phone")?.scrollIntoView({ block: "start" }), 50);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [loaded]);
  if (!data) return <section className="card skeleton" id="phone" />;
  const i: PhoneInfo = data;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      toast(ok);
      setLogins(undefined);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = i.tailscale === "ready";
  const loginText = logins ?? i.allowedLogins.join(", ");

  return (
    <section className="card" id="phone">
      <h3>Phone access: {i.on ? "on" : "off"}</h3>
      <p className="muted">
        Open this dashboard on your phone through Tailscale. It stays private to your own Tailscale network,
        your tailnet. Nothing is public.
      </p>

      {!ready && (
        <div className="hint phone-setup">
          <strong>
            {i.tailscale === "missing"
              ? "Tailscale is not installed on this Mac."
              : `Tailscale is installed but not signed in${i.detail ? ` (${i.detail})` : ""}.`}
          </strong>
          <ol>
            <li>
              Install Tailscale on this Mac and on your phone, from{" "}
              <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                tailscale.com/download
              </a>
              .
            </li>
            <li>Sign in on both with the same account. It is free for personal use.</li>
            <li>
              In the{" "}
              <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">
                Tailscale admin page
              </a>
              , turn on MagicDNS and HTTPS Certificates.
            </li>
            <li>Come back here and turn phone access on.</li>
          </ol>
        </div>
      )}

      {ready && (
        <dl className="kv">
          {i.on && i.url && (
            <>
              <dt>Open on your phone</dt>
              <dd className="phone-url">
                <a href={i.url} target="_blank" rel="noreferrer">
                  {i.url}
                </a>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => toast((await copyText(i.url ?? "")) ? "Copied" : "Could not copy")}
                >
                  Copy
                </button>
              </dd>
            </>
          )}
          <dt>HTTPS port</dt>
          <dd>{i.httpsPort}</dd>
          <dt>Who can open it</dt>
          <dd>
            {i.canChange ? (
              <div className="phone-logins">
                <input
                  aria-label="Tailscale logins that may open the dashboard, comma separated"
                  value={loginText}
                  placeholder={i.login ?? "you@example.com"}
                  onChange={(e) => setLogins(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || logins === undefined}
                  onClick={() =>
                    act(
                      () =>
                        api.setPhoneLogins(
                          loginText
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean),
                        ),
                      "Saved who can open it",
                    )
                  }
                >
                  Save
                </button>
              </div>
            ) : (
              i.allowedLogins.join(", ") || "nobody yet"
            )}
            <span className="small muted">
              Tailscale logins, comma separated.
              {i.on && !i.allowedLogins.length ? " Nobody can open it until you add one." : ""}
            </span>
          </dd>
        </dl>
      )}

      {error && <p className="banner banner-red phone-error">{error}</p>}

      <div className="linkedin-row">
        {ready && i.canChange && (
          <button
            type="button"
            className={`btn ${i.on ? "" : "btn-primary"}`}
            disabled={busy}
            onClick={() =>
              act(() => api.setPhone(!i.on), i.on ? "Phone access is off" : "Phone access is on")
            }
          >
            {busy ? "Working…" : i.on ? "Turn off phone access" : "Turn on phone access"}
          </button>
        )}
        <a href={PHONE_DOCS} target="_blank" rel="noreferrer">
          How phone access works
        </a>
      </div>
      {!i.canChange && (
        <p className="small muted">Phone access can only be switched on or off on the Mac itself.</p>
      )}
    </section>
  );
}
