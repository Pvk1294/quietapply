// Mirrors of the choices in src/core/config.ts (SENIORITY) and src/companies/starter.ts (INDUSTRIES).
// The dashboard bundle does not import server code, so keep these in step by hand.

export const SENIORITY = [
  { id: "intern", label: "Intern" },
  { id: "entry", label: "Entry / junior" },
  { id: "mid", label: "Mid level" },
  { id: "senior", label: "Senior" },
  { id: "staff", label: "Staff / principal" },
  { id: "lead", label: "Lead / manager" },
  { id: "director", label: "Director+" },
];

export const INDUSTRIES = [
  { id: "ai", label: "AI" },
  { id: "devtools", label: "Developer tools" },
  { id: "infra", label: "Cloud & infrastructure" },
  { id: "data", label: "Data & analytics" },
  { id: "security", label: "Security" },
  { id: "fintech", label: "Fintech" },
  { id: "crypto", label: "Crypto" },
  { id: "saas", label: "Business software" },
  { id: "hr", label: "HR & recruiting" },
  { id: "marketing", label: "Marketing tech" },
  { id: "ecommerce", label: "E-commerce & delivery" },
  { id: "consumer", label: "Consumer apps" },
  { id: "media", label: "Media & content" },
  { id: "gaming", label: "Gaming" },
  { id: "health", label: "Health" },
  { id: "edtech", label: "Education" },
  { id: "mobility", label: "Mobility" },
  { id: "logistics", label: "Logistics" },
  { id: "hardware", label: "Hardware & space" },
  { id: "climate", label: "Climate & energy" },
];

export const SIZES = [
  { id: "startup", label: "Startup (<200)" },
  { id: "scaleup", label: "Scale-up (200–2,000)" },
  { id: "large", label: "Large (2,000+)" },
];

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "CAD", "AUD", "SGD", "AED"];

export const COVER_LETTER = [
  { id: "short", label: "Short and direct" },
  { id: "warm", label: "Warm and personal" },
  { id: "formal", label: "Formal" },
  { id: "template", label: "My own template (in Memory)" },
  { id: "none", label: "Skip optional cover letters" },
];
