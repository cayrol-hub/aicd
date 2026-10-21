import type {DeploymentState, JobStatus} from "@aicd-ci/plugin-sdk";
import type {AicdEvent} from "./events.js";
import {at, defined, isoDate, obj, str} from "./json.js";

const FINISHED_PIPELINE: Record<string, JobStatus> = {
    success: "success",
    failed: "failed",
    canceled: "canceled",
    skipped: "skipped"
};

const MERGE_REQUEST_ACTIONS = new Set(["open", "reopen", "update"]);

function deploymentState(value: string | undefined): DeploymentState {
    switch (value) {
        case "success":
            return "success";
        case "failed":
            return "failed";
        case "created":
        case "running":
            return "in_progress";
        default:
            return "unknown";
    }
}

/** An `update` matters only when it brings commits or changes the title or the description (not labels, assignees…). */
function relevantUpdate(payload: unknown): boolean {
    return Boolean(
        str(payload, "object_attributes", "oldrev") ||
        obj(at(payload, "changes", "title")) ||
        obj(at(payload, "changes", "description"))
    );
}

/**
 * Normalizes a GitLab webhook (`X-Gitlab-Event` + JSON payload): finished `Pipeline Hook`, `Merge Request Hook`
 * (open, reopen, update with new commits or a new title/description), `Deployment Hook` and `Tag Push Hook`.
 * Anything else gives `[]`.
 */
/** A merge request whose source project is not its target project comes from a fork. */
function differentProjects(mergeRequest: unknown): boolean {
    const source = str(mergeRequest, "source_project_id");
    const target = str(mergeRequest, "target_project_id");
    return source !== undefined && target !== undefined && source !== target;
}

export function normalizeGitLab(eventName: string, payload: unknown, now: Date = new Date()): AicdEvent[] {
    const repository = str(payload, "project", "path_with_namespace");
    if (!repository) return [];
    switch (eventName) {
        case "Pipeline Hook": {
            const attributes = obj(at(payload, "object_attributes"));
            const id = str(attributes, "id");
            const status = FINISHED_PIPELINE[str(attributes, "status") ?? ""];
            if (!id || !status) return [];
            const projectUrl = str(payload, "project", "web_url");
            return [
                {
                    type: "pipeline_completed",
                    provider: "gitlab",
                    repository,
                    pipelineId: id,
                    status,
                    fork: differentProjects(at(payload, "merge_request")),
                    ...defined({
                        branch: at(attributes, "tag") === true ? undefined : str(attributes, "ref"),
                        sha: str(attributes, "sha"),
                        mergeRequestId: str(payload, "merge_request", "iid"),
                        url: str(attributes, "url") ?? (projectUrl ? `${projectUrl}/-/pipelines/${id}` : undefined)
                    })
                }
            ];
        }
        case "Merge Request Hook": {
            const attributes = obj(at(payload, "object_attributes"));
            const action = str(attributes, "action");
            const id = str(attributes, "iid");
            const sha = str(attributes, "last_commit", "id");
            if (!action || !MERGE_REQUEST_ACTIONS.has(action) || !id || !sha) return [];
            if (action === "update" && !relevantUpdate(payload)) return [];
            return [
                {
                    type: "merge_request_updated",
                    provider: "gitlab",
                    repository,
                    id,
                    title: str(attributes, "title") ?? "",
                    description: str(attributes, "description") ?? "",
                    sourceBranch: str(attributes, "source_branch") ?? "",
                    targetBranch: str(attributes, "target_branch") ?? "",
                    sha,
                    url: str(attributes, "url") ?? "",
                    fork: differentProjects(attributes)
                }
            ];
        }
        case "Deployment Hook": {
            const id = str(payload, "deployment_id");
            const environment = str(payload, "environment");
            if (!id || !environment) return [];
            // The payload has no full SHA field: it is the last segment of `commit_url`.
            const fromUrl = /\/commit\/([0-9a-f]{7,64})$/.exec(str(payload, "commit_url") ?? "")?.[1];
            return [
                {
                    type: "deployment",
                    provider: "gitlab",
                    repository,
                    id,
                    environment,
                    status: deploymentState(str(payload, "status")),
                    startedAt: isoDate(str(payload, "status_changed_at")) ?? now.toISOString(),
                    ...defined({
                        sha: fromUrl ?? str(payload, "short_sha"),
                        url: str(payload, "deployable_url") ?? str(payload, "environment_external_url")
                    })
                }
            ];
        }
        case "Tag Push Hook": {
            const ref = str(payload, "ref");
            // A deleted tag has a null `checkout_sha`.
            const sha = str(payload, "checkout_sha");
            if (!ref?.startsWith("refs/tags/") || !sha || /^0+$/.test(sha)) return [];
            return [{type: "tag_pushed", provider: "gitlab", repository, tag: ref.slice("refs/tags/".length), sha}];
        }
        default:
            return [];
    }
}
