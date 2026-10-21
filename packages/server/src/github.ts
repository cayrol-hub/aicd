import type {DeploymentState, JobStatus} from "@aicd-ci/plugin-sdk";
import type {AicdEvent} from "./events.js";
import {at, defined, isoDate, obj, str} from "./json.js";

const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened", "edited"]);

function conclusion(value: string | undefined): JobStatus {
    switch (value) {
        case "success":
            return "success";
        case "failure":
        case "timed_out":
        case "startup_failure":
            return "failed";
        case "cancelled":
            return "canceled";
        case "skipped":
            return "skipped";
        default:
            return "other";
    }
}

function deploymentState(value: string | undefined): DeploymentState {
    switch (value) {
        case "success":
            return "success";
        case "failure":
        case "error":
            return "failed";
        case "pending":
        case "queued":
        case "in_progress":
            return "in_progress";
        default:
            return "unknown";
    }
}

/**
 * Normalizes a GitHub webhook (`X-GitHub-Event` + JSON payload): completed `workflow_run`, `pull_request`
 * (opened, synchronize, reopened, edited), `deployment_status` and the push of a tag. Anything else gives `[]`.
 */
export function normalizeGitHub(eventName: string, payload: unknown, now: Date = new Date()): AicdEvent[] {
    const repository = str(payload, "repository", "full_name");
    if (!repository) return [];
    const action = str(payload, "action");
    switch (eventName) {
        case "workflow_run": {
            const run = obj(at(payload, "workflow_run"));
            const id = str(run, "id");
            if (action !== "completed" || !id) return [];
            const pullRequests = at(run, "pull_requests");
            const firstPullRequest = Array.isArray(pullRequests) ? str(pullRequests[0], "number") : undefined;
            // Runs of fork pull requests carry the fork as head repository (and no pull_requests entry).
            const headRepository = str(run, "head_repository", "full_name");
            return [
                {
                    type: "pipeline_completed",
                    provider: "github",
                    repository,
                    pipelineId: id,
                    status: conclusion(str(run, "conclusion")),
                    fork: headRepository !== undefined && headRepository !== repository,
                    ...defined({
                        branch: str(run, "head_branch"),
                        sha: str(run, "head_sha"),
                        mergeRequestId: firstPullRequest,
                        url: str(run, "html_url")
                    })
                }
            ];
        }
        case "pull_request": {
            const pullRequest = obj(at(payload, "pull_request"));
            const id = str(pullRequest, "number");
            const sha = str(pullRequest, "head", "sha");
            if (!action || !PULL_REQUEST_ACTIONS.has(action) || !id || !sha) return [];
            return [
                {
                    type: "merge_request_updated",
                    provider: "github",
                    repository,
                    id,
                    title: str(pullRequest, "title") ?? "",
                    description: str(pullRequest, "body") ?? "",
                    sourceBranch: str(pullRequest, "head", "ref") ?? "",
                    targetBranch: str(pullRequest, "base", "ref") ?? "",
                    sha,
                    url: str(pullRequest, "html_url") ?? "",
                    // A deleted fork leaves `head.repo` null: still a fork.
                    fork:
                        at(pullRequest, "head", "repo") === null ||
                        str(pullRequest, "head", "repo", "full_name") !== str(pullRequest, "base", "repo", "full_name")
                }
            ];
        }
        case "deployment_status": {
            const deployment = obj(at(payload, "deployment"));
            const status = obj(at(payload, "deployment_status"));
            const id = str(deployment, "id");
            const environment = str(status, "environment") ?? str(deployment, "environment");
            if (!id || !environment) return [];
            return [
                {
                    type: "deployment",
                    provider: "github",
                    repository,
                    id,
                    environment,
                    status: deploymentState(str(status, "state")),
                    startedAt: isoDate(str(deployment, "created_at")) ?? now.toISOString(),
                    ...defined({
                        sha: str(deployment, "sha"),
                        url: str(status, "target_url") ?? str(status, "environment_url") ?? str(status, "log_url")
                    })
                }
            ];
        }
        case "push": {
            const ref = str(payload, "ref");
            if (!ref?.startsWith("refs/tags/") || at(payload, "deleted") === true) return [];
            // For an annotated tag `after` is the tag object; the head commit is what was released.
            const sha = str(payload, "head_commit", "id") ?? str(payload, "after");
            if (!sha) return [];
            return [{type: "tag_pushed", provider: "github", repository, tag: ref.slice("refs/tags/".length), sha}];
        }
        default:
            return [];
    }
}
