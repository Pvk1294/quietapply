import { useState } from "react";
import { api } from "../api";
import { toast } from "../ui";

/** Paste a job link to queue it. Greenhouse, Lever and Ashby links work; LinkedIn links need LinkedIn mode. */
export function AddJob({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.addJob(url.trim());
      toast(r.created ? "Added. It will be picked up at the next run." : "That job is already in your list.");
      setUrl("");
      onAdded();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="linkedin-row">
      <input
        className="grow"
        placeholder="Paste a job link to add it (Greenhouse, Lever, Ashby, or LinkedIn in LinkedIn mode)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      <button type="button" className="btn" disabled={busy || !url.trim()} onClick={add}>
        Add job
      </button>
    </div>
  );
}
