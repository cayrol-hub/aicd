import {parseDocument, Scalar, visit} from "yaml";

export interface ConfigFile {
    path: string;
    content: string;
}

export type CiFlavor = "gitlab" | "github";

/** One job of a CI configuration, normalized across GitLab and GitHub. */
export interface CiJob {
    name: string;
    file: string;
    flavor: CiFlavor;
    stage?: string;
    /** Commands run by the job (GitLab before_script + script, GitHub `run` steps), one per line. */
    scripts: string[];
    /** Main commands only (GitLab `script`, GitHub `run` steps): used to find duplicated jobs. */
    mainScript: string[];
    /** What makes two jobs with the same script intentionally different (image, matrix, variables…). */
    variant: string;
    hasCache: boolean;
    /** GitLab `needs` (including `needs: []`). */
    usesNeeds: boolean;
    interruptible: boolean;
    /** GitLab `rules: changes` or `only/except: changes`. */
    hasChangesRule: boolean;
}

/** A GitHub workflow file: triggers and cancellation settings. */
export interface CiWorkflow {
    file: string;
    /** Triggered by push or pull_request on branches (path filters matter). */
    onCodeChanges: boolean;
    hasPathFilter: boolean;
    cancelsSuperseded: boolean;
}

export interface CiConfig {
    jobs: CiJob[];
    workflows: CiWorkflow[];
    /** GitLab stages in order. */
    stages: string[];
    /** GitLab `workflow: rules: changes`. */
    gitlabWorkflowChanges: boolean;
    gitlabFiles: string[];
    errors: string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const REFERENCE = "\u0000aicd-reference:";

/** Parses YAML; GitLab `!reference [job, key]` tags are resolved against the same document. */
export function parseYaml(content: string): {value?: unknown; errors: string[]} {
    const document = parseDocument(content, {logLevel: "error", uniqueKeys: false});
    if (document.errors.length > 0) return {errors: document.errors.map((error) => error.message.split("\n")[0] ?? "")};
    visit(document, {
        Seq(_, node) {
            if (node.tag === "!reference") return new Scalar(REFERENCE + JSON.stringify(node.toJSON()));
            return undefined;
        }
    });
    const value = document.toJS({maxAliasCount: 1000}) as unknown;
    return {value: resolveReferences(value, value, 0), errors: []};
}

function resolveReferences(node: unknown, root: unknown, depth: number): unknown {
    if (depth > 10) return node;
    if (typeof node === "string" && node.startsWith(REFERENCE)) {
        const path = JSON.parse(node.slice(REFERENCE.length)) as string[];
        let target: unknown = root;
        for (const key of path) target = isObject(target) ? target[key] : undefined;
        return resolveReferences(target ?? [], root, depth + 1);
    }
    if (Array.isArray(node)) {
        return node.flatMap((item) => {
            const resolved = resolveReferences(item, root, depth);
            return typeof item === "string" && item.startsWith(REFERENCE) && Array.isArray(resolved)
                ? resolved
                : [resolved];
        });
    }
    if (isObject(node)) {
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [key, resolveReferences(value, root, depth)])
        );
    }
    return node;
}

/** Which CI a file belongs to, from its path; `fallback` (the provider) otherwise. */
export function flavorOf(path: string, fallback: string): CiFlavor | undefined {
    if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return "github";
    if (/\.gitlab-ci\.ya?ml$/.test(path) || /(^|\/)\.gitlab\//.test(path)) return "gitlab";
    return fallback === "github" || fallback === "gitlab" ? fallback : undefined;
}

/** Commands of a script field: a string or a (nested) list of strings, split into lines. */
function lines(value: unknown): string[] {
    if (typeof value === "string")
        return value
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    if (Array.isArray(value)) return value.flatMap(lines);
    return [];
}

function deepMerge(base: Json, patch: Json): Json {
    const out: Json = {...base};
    for (const [key, value] of Object.entries(patch)) {
        out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key] as Json, value) : value;
    }
    return out;
}

const GITLAB_RESERVED = new Set([
    "stages",
    "variables",
    "default",
    "include",
    "workflow",
    "image",
    "services",
    "cache",
    "before_script",
    "after_script",
    "spec"
]);

function resolveExtends(job: Json, document: Json, depth = 0): Json {
    if (depth > 10 || job.extends === undefined) return job;
    const parents = (Array.isArray(job.extends) ? job.extends : [job.extends]).filter(
        (name): name is string => typeof name === "string"
    );
    let merged: Json = {};
    for (const name of parents) {
        const parent = document[name];
        if (isObject(parent)) merged = deepMerge(merged, resolveExtends(parent, document, depth + 1));
    }
    const {extends: _ignored, ...own} = job;
    return deepMerge(merged, own);
}

const hasCacheValue = (value: unknown) =>
    value !== undefined && value !== null && value !== false && !(Array.isArray(value) && value.length === 0);

const hasChanges = (job: Json) =>
    (Array.isArray(job.rules) && job.rules.some((rule) => isObject(rule) && rule.changes !== undefined)) ||
    (isObject(job.only) && job.only.changes !== undefined) ||
    (isObject(job.except) && job.except.changes !== undefined);

function parseGitlab(file: string, document: Json, config: CiConfig): void {
    config.gitlabFiles.push(file);
    const defaults = isObject(document.default) ? document.default : {};
    if (Array.isArray(document.stages)) {
        for (const stage of document.stages)
            if (typeof stage === "string" && !config.stages.includes(stage)) config.stages.push(stage);
    }
    const workflow = isObject(document.workflow) ? document.workflow : {};
    if (hasChanges(workflow)) config.gitlabWorkflowChanges = true;
    const globalCache = hasCacheValue(defaults.cache) || hasCacheValue(document.cache);

    for (const [name, raw] of Object.entries(document)) {
        if (GITLAB_RESERVED.has(name) || name.startsWith(".") || !isObject(raw)) continue;
        const job = resolveExtends(raw, document);
        if (job.script === undefined && job.trigger === undefined) continue;
        const before = job.before_script ?? defaults.before_script ?? document.before_script;
        const mainScript = lines(job.script);
        config.jobs.push({
            name,
            file,
            flavor: "gitlab",
            stage: typeof job.stage === "string" ? job.stage : "test",
            scripts: [...lines(before), ...mainScript],
            mainScript,
            variant: JSON.stringify([
                job.image ?? null,
                job.variables ?? null,
                job.parallel ?? null,
                job.services ?? null
            ]),
            hasCache: job.cache !== undefined ? hasCacheValue(job.cache) : globalCache,
            usesNeeds: job.needs !== undefined,
            interruptible: (job.interruptible ?? defaults.interruptible) === true,
            hasChangesRule: hasChanges(job)
        });
    }
}

const PATH_FILTER_EVENTS = ["push", "pull_request", "pull_request_target"];

function workflowTriggers(on: unknown): {onCodeChanges: boolean; hasPathFilter: boolean} {
    if (typeof on === "string") return {onCodeChanges: PATH_FILTER_EVENTS.includes(on), hasPathFilter: false};
    if (Array.isArray(on))
        return {onCodeChanges: on.some((event) => PATH_FILTER_EVENTS.includes(String(event))), hasPathFilter: false};
    if (!isObject(on)) return {onCodeChanges: false, hasPathFilter: false};
    let onCodeChanges = false;
    let hasPathFilter = true;
    for (const event of PATH_FILTER_EVENTS) {
        if (!(event in on)) continue;
        const filter = on[event];
        // A push filtered on tags only does not run on code changes.
        if (
            isObject(filter) &&
            filter.tags !== undefined &&
            filter.branches === undefined &&
            filter["branches-ignore"] === undefined
        )
            continue;
        onCodeChanges = true;
        if (!isObject(filter) || (filter.paths === undefined && filter["paths-ignore"] === undefined))
            hasPathFilter = false;
    }
    return {onCodeChanges, hasPathFilter: onCodeChanges && hasPathFilter};
}

const cancels = (value: unknown) =>
    isObject(value) && value["cancel-in-progress"] !== undefined && value["cancel-in-progress"] !== false;

const SETUP_WITH_CACHE = /^actions\/setup-(node|python|java|go|dotnet)@/;

function githubJobHasCache(steps: unknown[]): boolean {
    return steps.some((step) => {
        if (!isObject(step) || typeof step.uses !== "string") return false;
        const uses = step.uses;
        const inputs = isObject(step.with) ? step.with : {};
        if (/^actions\/cache(\/restore)?@/.test(uses)) return true;
        if (/^(gradle\/actions\/setup-gradle|gradle\/gradle-build-action)@/.test(uses)) return true;
        if (/^ruby\/setup-ruby@/.test(uses)) return hasCacheValue(inputs["bundler-cache"]);
        // setup-go caches by default since v4.
        const goDefault = /^actions\/setup-go@v([4-9]|\d{2,})/.test(uses) && inputs.cache !== false;
        return (
            SETUP_WITH_CACHE.test(uses) &&
            (goDefault || (inputs.cache !== undefined && inputs.cache !== false && inputs.cache !== ""))
        );
    });
}

function parseGithub(file: string, document: Json, config: CiConfig): void {
    const triggers = workflowTriggers(document.on);
    const jobs = isObject(document.jobs) ? document.jobs : {};
    const jobEntries = Object.entries(jobs).filter((entry): entry is [string, Json] => isObject(entry[1]));
    const allJobsCancel = jobEntries.length > 0 && jobEntries.every(([, job]) => cancels(job.concurrency));
    config.workflows.push({file, ...triggers, cancelsSuperseded: cancels(document.concurrency) || allJobsCancel});
    for (const [name, job] of jobEntries) {
        if (typeof job.uses === "string") continue; // reusable workflow call
        const steps = Array.isArray(job.steps) ? job.steps : [];
        const mainScript = steps.flatMap((step) => (isObject(step) ? lines(step.run) : []));
        config.jobs.push({
            name,
            file,
            flavor: "github",
            scripts: mainScript,
            mainScript,
            variant: JSON.stringify([
                job["runs-on"] ?? null,
                job.strategy ?? null,
                job.env ?? null,
                job.container ?? null
            ]),
            hasCache: githubJobHasCache(steps),
            usesNeeds: job.needs !== undefined,
            interruptible: cancels(job.concurrency),
            hasChangesRule: false
        });
    }
}

/** Parses GitLab and GitHub CI files into one normalized model. Unparsable files are listed in `errors`. */
export function parseCiConfig(provider: string, files: ConfigFile[]): CiConfig {
    const config: CiConfig = {
        jobs: [],
        workflows: [],
        stages: [],
        gitlabWorkflowChanges: false,
        gitlabFiles: [],
        errors: []
    };
    for (const file of files) {
        const flavor = flavorOf(file.path, provider);
        if (!flavor) {
            config.errors.push(`${file.path}: unknown CI provider`);
            continue;
        }
        const parsed = parseYaml(file.content);
        if (parsed.errors.length > 0 || !isObject(parsed.value)) {
            config.errors.push(`${file.path}: ${parsed.errors[0] ?? "not a YAML mapping"}`);
            continue;
        }
        if (flavor === "gitlab") parseGitlab(file.path, parsed.value, config);
        else parseGithub(file.path, parsed.value, config);
    }
    return config;
}

/**
 * 1-based line of the first line of `content` containing `needle`. With `block`, the line is looked
 * for first inside the YAML block of that key (a job), then anywhere (e.g. in a template it extends).
 */
export function lineOf(content: string, needle: string, block?: string): number | undefined {
    const all = content.split("\n");
    if (block) {
        const start = all.findIndex((line) => line.trim() === `${block}:` || line.trim().startsWith(`${block}: `));
        if (start !== -1) {
            const indent = (all[start] as string).search(/\S/);
            for (let index = start + 1; index < all.length; index++) {
                const line = all[index] as string;
                if (line.trim() !== "" && line.search(/\S/) <= indent) break;
                if (line.includes(needle)) return index + 1;
            }
        }
    }
    const index = all.findIndex((line) => line.includes(needle));
    return index === -1 ? undefined : index + 1;
}
