/**
 * Language identifiers follow Monaco's ids where one exists, so the web UI can
 * use them directly for syntax highlighting.
 */
const byExtension: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "groovy",
  gradle: "groovy",
  cs: "csharp",
  csx: "csharp",
  cshtml: "razor",
  razor: "razor",
  vb: "vb",
  fs: "fsharp",
  go: "go",
  py: "python",
  pyi: "python",
  rb: "ruby",
  php: "php",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  m: "objective-c",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  pl: "perl",
  pm: "perl",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  sql: "sql",
  html: "html",
  htm: "html",
  jsp: "html",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  xaml: "xml",
  csproj: "xml",
  props: "xml",
  xsd: "xml",
  wsdl: "xml",
  svg: "xml",
  md: "markdown",
  mdx: "markdown",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  bat: "bat",
  cmd: "bat",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  tf: "hcl",
  hcl: "hcl"
}

const byFileName: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  jenkinsfile: "groovy"
}

export const detectLanguage = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const fromName = byFileName[name]
  if (fromName !== undefined) return fromName
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile"
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return "plaintext"
  return byExtension[name.slice(dot + 1)] ?? "plaintext"
}
