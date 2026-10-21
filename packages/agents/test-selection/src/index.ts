export {AGENT_NAME, runTestSelection, type TestSelectionInput, type TestSelectionOptions} from "./agent.js";
export {parseCobertura, parseJaCoCo, parseLcov, type CoverageParseOptions, type CoverageReport} from "./coverage.js";
export {
    DEFAULT_IGNORE,
    DEFAULT_TEST_PATTERNS,
    discoverTests,
    isTestPath,
    listSourceFiles,
    SOURCE_EXTENSIONS,
    type DiscoverOptions
} from "./discover.js";
export {missedRegressions, recordSelection, testIdMatches, type MissedRegression} from "./history.js";
export {
    buildCoverageMap,
    conventionSources,
    indexSources,
    loadCoverageMap,
    resolveTestKey,
    saveCoverageMap,
    SOURCE_TRUST,
    testSubject,
    type BuildCoverageMapOptions,
    type CoChangeOptions,
    type CoverageMap,
    type CoverageMapEntry,
    type CoverageSource
} from "./mapping.js";
export {branchMatches, globToRegExp, matchesGlob, normalizePath, shellQuote} from "./paths.js";
export {COMMENT_MARKER, describeDecision, formatSelection, renderSelectionSummary} from "./render.js";
export {
    DEFAULT_FORCE_FULL_PATTERNS,
    DEFAULT_FULL_SUITE_BRANCHES,
    DEFAULT_IGNORE_PATTERNS,
    selectTests,
    type ChangedFile,
    type ChangeStatus,
    type SelectInput,
    type Selection,
    type SelectionDecision,
    type SelectionOptions
} from "./select.js";
