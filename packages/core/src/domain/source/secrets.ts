/**
 * Detection and masking of credentials in source code.
 *
 * Masking runs before any content is stored or sent to a model. Matched
 * secrets are replaced with `[REDACTED:<rule>]`; newlines inside a match are
 * preserved so that line numbers of the masked text stay identical to the
 * original (card references point at these lines).
 *
 * Only the rule id and the line number of each finding are reported, never the
 * secret itself.
 */
import type { SecretFinding } from "../model.ts"

export interface MaskResult {
  readonly text: string
  readonly findings: ReadonlyArray<SecretFinding>
}

interface Rule {
  readonly id: string
  /** Must use the `d` and `g` flags and capture the secret in the `secret` group. */
  readonly pattern: RegExp
  /** Optional extra check on the captured secret to reduce false positives. */
  readonly accept?: (secret: string) => boolean
  /** Only for configuration-like files: in source code an unquoted value is an expression, not a literal. */
  readonly configOnly?: boolean
}

/**
 * Languages (as in `detectLanguage`) whose files hold `key=value` settings, where secrets are often unquoted:
 * `.env` files and the like are `plaintext`.
 */
const configLanguages = new Set([
  "plaintext",
  "ini",
  "yaml",
  "toml",
  "shell",
  "powershell",
  "bat",
  "dockerfile",
  "makefile",
  "hcl",
  "markdown"
])

const sensitiveKey = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|conn(?:ection)?[_-]?str(?:ing)?)[A-Za-z0-9_.-]*`

/** Keys that name a password: any literal assigned to them is masked, however short or simple. */
const passwordKey = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|pwd|passphrase)[A-Za-z0-9_.-]*`

/** Values that are clearly not secrets even when assigned to a sensitive-looking key. */
const harmlessValues = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "bearer",
  "basic",
  "required",
  "string",
  "null",
  "undefined",
  "none",
  "true",
  "false",
  "text",
  "hidden"
])

const shannonEntropy = (value: string): number => {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/** References, environment lookups and template placeholders: the value is elsewhere, not in the file. */
const isReference = (value: string): boolean =>
  /^(?:\$|%|\{\{|<|process\.env|env\(|os\.environ|System\.getenv|Environment\.)/i.test(value)

/** Accepts literal values that look like real credentials rather than references or messages. */
const looksLikeSecretValue = (value: string): boolean => {
  if (value.length < 6) return false
  if (/\s/.test(value)) return false
  if (isReference(value)) return false
  if (/^[*xX•.-]+$/.test(value)) return false
  if (harmlessValues.has(value.toLowerCase())) return false
  return shannonEntropy(value) >= 2.5
}

/**
 * Accepts any literal assigned to a password key: weak and test passwords ("test", "admin1") are still real
 * credentials. Messages (with spaces), references, masks and type names are left alone.
 */
const looksLikePasswordValue = (value: string): boolean =>
  value.length > 0 &&
  !/\s/.test(value) &&
  !isReference(value) &&
  !/^[*xX•.-]+$/.test(value) &&
  !["null", "undefined", "none", "true", "false", "string", "required", "text", "hidden"].includes(value.toLowerCase())

const rules: ReadonlyArray<Rule> = [
  {
    id: "private-key",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?<secret>[\s\S]*?)-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/dg
  },
  { id: "aws-access-key-id", pattern: /\b(?<secret>(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/dg },
  {
    id: "aws-secret-access-key",
    pattern: /aws.{0,20}secret.{0,20}?[=:]\s*["'`]?(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/dgi
  },
  { id: "github-token", pattern: /\b(?<secret>gh[pousr]_[A-Za-z0-9]{36,255})\b/dg },
  { id: "github-token", pattern: /\b(?<secret>github_pat_[A-Za-z0-9_]{22,255})\b/dg },
  { id: "gitlab-token", pattern: /\b(?<secret>glpat-[A-Za-z0-9_-]{20,})/dg },
  { id: "slack-token", pattern: /\b(?<secret>xox[abposr]-[A-Za-z0-9-]{10,})/dg },
  { id: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/(?<secret>[A-Za-z0-9/_-]+)/dg },
  { id: "stripe-key", pattern: /\b(?<secret>(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/dg },
  { id: "google-api-key", pattern: /\b(?<secret>AIza[0-9A-Za-z_-]{35})/dg },
  { id: "openai-style-key", pattern: /\b(?<secret>sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})/dg },
  { id: "npm-token", pattern: /\b(?<secret>npm_[A-Za-z0-9]{36})\b/dg },
  { id: "sendgrid-key", pattern: /\b(?<secret>SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/dg },
  { id: "azure-storage-key", pattern: /AccountKey=(?<secret>[A-Za-z0-9+/=]{40,})/dg },
  {
    id: "jwt",
    pattern: /\b(?<secret>eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/dg
  },
  {
    id: "authorization-header",
    pattern: /\b(?:Basic|Bearer)\s+(?<secret>[A-Za-z0-9._~+/-]{16,}=*)/dg
  },
  {
    id: "url-credentials",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:(?<secret>[^\s@"'`/]+)@/dgi,
    accept: (secret) => !/^(?:\$|\{|%|\*+$)/.test(secret)
  },
  {
    id: "assigned-password",
    pattern: new RegExp(
      String.raw`${passwordKey}["'\]]?\s*(?:=|:=|:|=>)\s*@?(?<quote>["'\`])(?<secret>[^"'\`\r\n]+)\k<quote>`,
      "dgi"
    ),
    accept: looksLikePasswordValue
  },
  {
    id: "assigned-password",
    pattern: new RegExp(String.raw`^\s*(?:export\s+)?${passwordKey}\s*[=:]\s*(?<secret>[^\s"'\`#;]+)`, "dgim"),
    accept: looksLikePasswordValue,
    configOnly: true
  },
  {
    id: "assigned-secret",
    pattern: new RegExp(
      String.raw`${sensitiveKey}["'\]]?\s*(?:=|:=|:|=>)\s*@?(?<quote>["'\`])(?<secret>[^"'\`\r\n]+)\k<quote>`,
      "dgi"
    ),
    accept: looksLikeSecretValue
  },
  {
    id: "assigned-secret",
    pattern: new RegExp(String.raw`^\s*(?:export\s+)?${sensitiveKey}\s*[=:]\s*(?<secret>[^\s"'\`#;]+)`, "dgim"),
    accept: looksLikeSecretValue,
    configOnly: true
  }
]

interface Range {
  readonly start: number
  readonly end: number
  readonly rule: string
}

const lineAt = (text: string, offset: number): number => {
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Masks credentials in `text`. `language` (see `detectLanguage`) enables the rules meant for configuration files;
 * when omitted every rule applies.
 */
export const maskSecrets = (text: string, language?: string): MaskResult => {
  const isConfig = language === undefined || configLanguages.has(language)
  const ranges: Array<Range> = []
  for (const rule of rules) {
    if (rule.configOnly === true && !isConfig) continue
    rule.pattern.lastIndex = 0
    for (const match of text.matchAll(rule.pattern)) {
      const indices = match.indices?.groups?.["secret"]
      const secret = match.groups?.["secret"]
      if (indices === undefined || secret === undefined || secret.length === 0) continue
      if (rule.accept !== undefined && !rule.accept(secret)) continue
      ranges.push({ start: indices[0], end: indices[1], rule: rule.id })
    }
  }
  if (ranges.length === 0) return { text, findings: [] }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<Range> = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range.start < last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { ...last, end: range.end }
      continue
    }
    merged.push(range)
  }

  let output = ""
  let cursor = 0
  const findings: Array<SecretFinding> = []
  for (const range of merged) {
    output += text.slice(cursor, range.start)
    const placeholder = `[REDACTED:${range.rule}]`
    // Keep every newline of the secret so the masked text has the same lines.
    const secretLines = text.slice(range.start, range.end).split("\n")
    output += secretLines.map((part) => (part.trim().length === 0 ? part : placeholder)).join("\n")
    cursor = range.end
    findings.push({ rule: range.rule, line: lineAt(text, range.start) })
  }
  output += text.slice(cursor)
  return { text: output, findings }
}
