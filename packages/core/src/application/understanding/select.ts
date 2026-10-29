import type { SourceFileEntry } from "../../domain/model.ts"

/** Languages read as code by the understanding (those with static analysis). */
const CODE_LANGUAGES = new Set(["typescript", "javascript", "java", "csharp", "go", "python"])

/** Test code: it documents behaviour indirectly and would double the cost, so it is skipped. */
const TEST_PATH =
  /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|testdata|fixtures?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$|_test\.py$|Tests?\.(java|cs)$/i

/** Application settings the user may have to change: they belong to the "how to configure" part of the cards. */
const CONFIGURATION_FILE =
  /(^|\/)(application[^/]*\.(properties|ya?ml)|appsettings[^/]*\.json|bootstrap[^/]*\.ya?ml|\.env\.(example|sample|template)|[^/]*\.config\.(json|ya?ml|toml)|config\/[^/]+\.(json|ya?ml|toml|ini|properties))$/i

export const isTestPath = (path: string): boolean => TEST_PATH.test(path)

export const isConfigurationFile = (path: string): boolean => CONFIGURATION_FILE.test(path)

/** Files the understanding reads: application code (no tests) and configuration files. */
export const selectFiles = (files: ReadonlyArray<SourceFileEntry>): ReadonlyArray<SourceFileEntry> =>
  files.filter(
    (file) =>
      !file.isDirectory &&
      file.excludedReason === null &&
      file.lineCount > 0 &&
      ((CODE_LANGUAGES.has(file.language) && !isTestPath(file.path)) || isConfigurationFile(file.path))
  )
