import { parseForm } from "../forms/parse.js";
import { applyUrl, detectAts } from "../sources/detect.js";
import { greenhouseQuestions } from "../sources/greenhouse.js";
import type { Fetcher } from "../sources/http.js";
import type { FormField, FormInfo } from "../sources/types.js";

/**
 * The questions a job's form will ask, fetched before the agent starts so the prompt can carry just the
 * matching answers. Greenhouse publishes them in its API; Lever's form is server-rendered HTML; Ashby
 * renders in the browser, so it usually yields nothing here and the agent looks answers up live.
 */
export async function expectedForm(fetcher: Fetcher, url: string): Promise<FormInfo | undefined> {
  try {
    const ref = detectAts(url);
    if (ref?.ats === "greenhouse" && ref.jobId) {
      const fields: FormField[] = await greenhouseQuestions(fetcher, ref.token, ref.jobId);
      return { fields, captcha: false, accountRequired: false };
    }
    const form = parseForm(await fetcher(applyUrl(url)));
    return form.fields.length ? form : undefined;
  } catch {
    return undefined;
  }
}
