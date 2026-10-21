import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {
    alertSeverity,
    normalizeAlert,
    normalizeAlertmanager,
    normalizeGenericAlert,
    normalizeGitHub,
    normalizeGitLab,
    normalizeSentry,
    PayloadError
} from "@aicd/server";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const SHA = "8f2c1d0b9e7a6f5c4d3b2a19087f6e5d4c3b2a10";

function fixture(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Record<
        string,
        unknown
    >;
}

function withChanges(name: string, change: (payload: any) => void): unknown {
    const payload = fixture(name);
    change(payload);
    return payload;
}

describe("normalizeGitHub", () => {
    it("maps a completed workflow run", () => {
        expect(normalizeGitHub("workflow_run", fixture("github-workflow-run"), NOW)).toEqual([
            {
                type: "pipeline_completed",
                provider: "github",
                repository: "acme/shop",
                pipelineId: "11223344556",
                status: "failed",
                branch: "feature/login",
                sha: SHA,
                mergeRequestId: "87",
                url: "https://github.com/acme/shop/actions/runs/11223344556",
                fork: false
            }
        ]);
    });

    it("maps conclusions and ignores runs that are not completed", () => {
        const conclusion = (value: unknown) =>
            normalizeGitHub(
                "workflow_run",
                withChanges("github-workflow-run", (payload) => (payload.workflow_run.conclusion = value))
            )[0];
        expect(conclusion("success")).toMatchObject({status: "success"});
        expect(conclusion("cancelled")).toMatchObject({status: "canceled"});
        expect(conclusion("timed_out")).toMatchObject({status: "failed"});
        expect(conclusion("neutral")).toMatchObject({status: "other"});
        expect(
            normalizeGitHub(
                "workflow_run",
                withChanges("github-workflow-run", (payload) => (payload.action = "requested"))
            )
        ).toEqual([]);
        const noPullRequest = normalizeGitHub(
            "workflow_run",
            withChanges("github-workflow-run", (payload) => (payload.workflow_run.pull_requests = []))
        )[0];
        expect(noPullRequest).not.toHaveProperty("mergeRequestId");
    });

    it("maps a pull request update and ignores closed ones", () => {
        expect(normalizeGitHub("pull_request", fixture("github-pull-request"))).toEqual([
            {
                type: "merge_request_updated",
                provider: "github",
                repository: "acme/shop",
                id: "87",
                title: "Add login with magic links",
                description: "Closes #80.\n\nAdds the magic link flow.",
                sourceBranch: "feature/login",
                targetBranch: "main",
                sha: SHA,
                url: "https://github.com/acme/shop/pull/87",
                fork: false
            }
        ]);
        expect(
            normalizeGitHub(
                "pull_request",
                withChanges("github-pull-request", (payload) => (payload.action = "closed"))
            )
        ).toEqual([]);
        const noBody = normalizeGitHub(
            "pull_request",
            withChanges("github-pull-request", (payload) => (payload.pull_request.body = null))
        )[0];
        expect(noBody).toMatchObject({description: ""});
    });

    it("maps a deployment status", () => {
        expect(normalizeGitHub("deployment_status", fixture("github-deployment-status"), NOW)).toEqual([
            {
                type: "deployment",
                provider: "github",
                repository: "acme/shop",
                id: "445566",
                environment: "production",
                status: "success",
                startedAt: "2026-10-21T09:01:12.000Z",
                sha: SHA,
                url: "https://github.com/acme/shop/actions/runs/11223344999"
            }
        ]);
        const state = (value: string) =>
            normalizeGitHub(
                "deployment_status",
                withChanges("github-deployment-status", (payload) => (payload.deployment_status.state = value))
            )[0];
        expect(state("error")).toMatchObject({status: "failed"});
        expect(state("in_progress")).toMatchObject({status: "in_progress"});
        expect(state("inactive")).toMatchObject({status: "unknown"});
    });

    it("maps a tag push to the released commit and ignores branches and deletions", () => {
        expect(normalizeGitHub("push", fixture("github-push-tag"))).toEqual([
            {type: "tag_pushed", provider: "github", repository: "acme/shop", tag: "v1.4.0", sha: SHA}
        ]);
        expect(
            normalizeGitHub(
                "push",
                withChanges("github-push-tag", (payload) => (payload.ref = "refs/heads/main"))
            )
        ).toEqual([]);
        expect(
            normalizeGitHub(
                "push",
                withChanges("github-push-tag", (payload) => (payload.deleted = true))
            )
        ).toEqual([]);
    });

    it("ignores unknown events and malformed payloads", () => {
        expect(
            normalizeGitHub("ping", {zen: "Keep it logically awesome.", repository: {full_name: "acme/shop"}})
        ).toEqual([]);
        expect(normalizeGitHub("workflow_run", null)).toEqual([]);
        expect(normalizeGitHub("workflow_run", [1, 2])).toEqual([]);
        expect(normalizeGitHub("pull_request", {repository: {full_name: "acme/shop"}, action: "opened"})).toEqual([]);
    });
});

describe("normalizeGitLab", () => {
    it("maps a finished pipeline", () => {
        expect(normalizeGitLab("Pipeline Hook", fixture("gitlab-pipeline"))).toEqual([
            {
                type: "pipeline_completed",
                provider: "gitlab",
                repository: "acme/shop",
                pipelineId: "1834567",
                status: "failed",
                branch: "feature/login",
                sha: SHA,
                mergeRequestId: "87",
                url: "https://gitlab.com/acme/shop/-/pipelines/1834567",
                fork: false
            }
        ]);
    });

    it("ignores running pipelines and builds the URL when missing", () => {
        expect(
            normalizeGitLab(
                "Pipeline Hook",
                withChanges("gitlab-pipeline", (payload) => (payload.object_attributes.status = "running"))
            )
        ).toEqual([]);
        const event = normalizeGitLab(
            "Pipeline Hook",
            withChanges("gitlab-pipeline", (payload) => {
                delete payload.object_attributes.url;
                payload.object_attributes.tag = true;
                payload.object_attributes.status = "success";
                delete payload.merge_request;
            })
        )[0];
        expect(event).toMatchObject({status: "success", url: "https://gitlab.com/acme/shop/-/pipelines/1834567"});
        expect(event).not.toHaveProperty("branch");
        expect(event).not.toHaveProperty("mergeRequestId");
    });

    it("maps merge request updates that bring commits, and ignores label-only updates", () => {
        expect(normalizeGitLab("Merge Request Hook", fixture("gitlab-merge-request"))).toEqual([
            {
                type: "merge_request_updated",
                provider: "gitlab",
                repository: "acme/shop",
                id: "87",
                title: "Add login with magic links",
                description: "Closes #80.",
                sourceBranch: "feature/login",
                targetBranch: "main",
                sha: SHA,
                url: "https://gitlab.com/acme/shop/-/merge_requests/87",
                fork: false
            }
        ]);
        const labelsOnly = withChanges("gitlab-merge-request", (payload) => {
            delete payload.object_attributes.oldrev;
            payload.changes = {labels: {previous: [], current: [{title: "bug"}]}};
        });
        expect(normalizeGitLab("Merge Request Hook", labelsOnly)).toEqual([]);
        const retitled = withChanges("gitlab-merge-request", (payload) => {
            delete payload.object_attributes.oldrev;
            payload.changes = {title: {previous: "WIP", current: "Add login with magic links"}};
        });
        expect(normalizeGitLab("Merge Request Hook", retitled)).toHaveLength(1);
        const opened = withChanges("gitlab-merge-request", (payload) => (payload.object_attributes.action = "open"));
        expect(normalizeGitLab("Merge Request Hook", opened)).toHaveLength(1);
        const merged = withChanges("gitlab-merge-request", (payload) => (payload.object_attributes.action = "merge"));
        expect(normalizeGitLab("Merge Request Hook", merged)).toEqual([]);
    });

    it("maps a deployment with the full SHA from the commit URL and an ISO date", () => {
        expect(normalizeGitLab("Deployment Hook", fixture("gitlab-deployment"), NOW)).toEqual([
            {
                type: "deployment",
                provider: "gitlab",
                repository: "acme/shop",
                id: "15",
                environment: "production",
                status: "success",
                startedAt: "2026-10-21T09:05:00.000Z",
                sha: SHA,
                url: "https://gitlab.com/acme/shop/-/jobs/796"
            }
        ]);
        const running = normalizeGitLab(
            "Deployment Hook",
            withChanges("gitlab-deployment", (payload) => {
                payload.status = "running";
                payload.status_changed_at = "garbage";
                delete payload.commit_url;
            }),
            NOW
        )[0];
        expect(running).toMatchObject({status: "in_progress", startedAt: NOW.toISOString(), sha: "8f2c1d0b"});
    });

    it("maps a tag push and ignores a deleted tag", () => {
        expect(normalizeGitLab("Tag Push Hook", fixture("gitlab-tag-push"))).toEqual([
            {type: "tag_pushed", provider: "gitlab", repository: "acme/shop", tag: "v1.4.0", sha: SHA}
        ]);
        expect(
            normalizeGitLab(
                "Tag Push Hook",
                withChanges("gitlab-tag-push", (payload) => (payload.checkout_sha = null))
            )
        ).toEqual([]);
    });

    it("ignores unknown events", () => {
        expect(normalizeGitLab("Note Hook", fixture("gitlab-merge-request"))).toEqual([]);
        expect(normalizeGitLab("Pipeline Hook", "nope")).toEqual([]);
    });
});

describe("alert normalizers", () => {
    it("maps a Sentry issue: created opens, resolved resolves, other actions are ignored", () => {
        expect(normalizeSentry(fixture("sentry-issue"), NOW)).toEqual([
            {
                type: "alert",
                source: "sentry",
                id: "4012345678",
                status: "opened",
                title: "TypeError: Cannot read properties of undefined (reading 'token')",
                severity: "critical",
                at: "2026-10-21T09:07:31.123Z",
                url: "https://acme.sentry.io/issues/4012345678/"
            }
        ]);
        const resolved = normalizeSentry(
            withChanges("sentry-issue", (payload) => (payload.action = "resolved")),
            NOW
        )[0];
        expect(resolved).toMatchObject({status: "resolved", at: NOW.toISOString()});
        expect(normalizeSentry(withChanges("sentry-issue", (payload) => (payload.action = "assigned")))).toEqual([]);
    });

    it("maps a Sentry event alert with the environment tag", () => {
        expect(normalizeSentry(fixture("sentry-event-alert"), NOW)).toEqual([
            {
                type: "alert",
                source: "sentry",
                id: "4012345678",
                status: "opened",
                title: "TypeError: Cannot read properties of undefined (reading 'token')",
                severity: "critical",
                at: "2026-10-21T09:07:31.123Z",
                environment: "production",
                url: "https://acme.sentry.io/organizations/acme/issues/4012345678/events/e4874d664c3540c1a32eab185f12c5ab/"
            }
        ]);
    });

    it("maps a Sentry metric alert and ignores installation hooks", () => {
        const payload = {
            action: "resolved",
            data: {
                metric_alert: {
                    id: "77",
                    alert_rule: {name: "p95 latency", environment: "production"},
                    date_closed: "2026-10-21T10:00:00Z"
                },
                description_title: "Resolved: p95 latency",
                web_url: "https://acme.sentry.io/alerts/rules/details/77/"
            }
        };
        expect(normalizeSentry(payload, NOW)).toEqual([
            {
                type: "alert",
                source: "sentry",
                id: "77",
                status: "resolved",
                title: "Resolved: p95 latency",
                severity: "warning",
                at: "2026-10-21T10:00:00.000Z",
                environment: "production",
                url: "https://acme.sentry.io/alerts/rules/details/77/"
            }
        ]);
        expect(normalizeSentry({action: "created", data: {installation: {uuid: "x"}}})).toEqual([]);
    });

    it("maps every Alertmanager alert, firing to opened and resolved to resolved", () => {
        expect(normalizeAlertmanager(fixture("alertmanager"), NOW)).toEqual([
            {
                type: "alert",
                source: "alertmanager",
                id: "c5f2d4e8a1b3c7d9",
                status: "opened",
                title: "5xx rate above 5% on checkout",
                severity: "critical",
                at: "2026-10-21T09:08:00.000Z",
                environment: "production",
                url: "http://prometheus.example.com:9090/graph?g0.expr=rate"
            },
            {
                type: "alert",
                source: "alertmanager",
                id: "0a1b2c3d4e5f6071",
                status: "resolved",
                title: "HighLatency",
                severity: "warning",
                at: "2026-10-21T09:00:00.000Z",
                environment: "production",
                url: "http://prometheus.example.com:9090/graph?g0.expr=histogram"
            }
        ]);
    });

    it("derives a stable Alertmanager id from the labels when the fingerprint is missing", () => {
        const alert = (labels: Record<string, string>) => ({
            alerts: [{status: "firing", labels, startsAt: "bad date"}]
        });
        const first = normalizeAlertmanager(alert({b: "2", a: "1"}), NOW)[0];
        const second = normalizeAlertmanager(alert({a: "1", b: "2"}), NOW)[0];
        expect(first?.id).toMatch(/^[0-9a-f]{16}$/);
        expect(first?.id).toBe(second?.id);
        expect(first).toMatchObject({title: "Prometheus alert", at: NOW.toISOString(), severity: "warning"});
        expect(() => normalizeAlertmanager({version: "4"})).toThrow(PayloadError);
        expect(normalizeAlertmanager({alerts: [{status: "unknown"}]})).toEqual([]);
    });

    it("validates and maps the generic format", () => {
        expect(normalizeGenericAlert(fixture("generic-alert"), NOW)).toEqual([
            {
                type: "alert",
                source: "generic",
                id: "checkout-down",
                status: "opened",
                title: "Checkout health check failing",
                severity: "critical",
                at: "2026-10-21T09:10:00.000Z",
                environment: "production",
                url: "https://status.example.com/incidents/12"
            }
        ]);
        expect(normalizeGenericAlert({id: 12, status: "OK", title: "Back"}, NOW)).toEqual([
            {
                type: "alert",
                source: "generic",
                id: "12",
                status: "resolved",
                title: "Back",
                severity: "warning",
                at: NOW.toISOString()
            }
        ]);
        expect(() => normalizeGenericAlert([], NOW)).toThrow(PayloadError);
        expect(() => normalizeGenericAlert({status: "opened", title: "x"})).toThrow(/id is required/);
        expect(() => normalizeGenericAlert({id: "a", status: "opened"})).toThrow(/title is required/);
        expect(() => normalizeGenericAlert({id: "a", status: "maybe", title: "x"})).toThrow(/status/);
        expect(() => normalizeGenericAlert({id: "a", status: "opened", title: "x", severity: "apocalyptic"})).toThrow(
            /severity/
        );
        expect(() => normalizeGenericAlert({id: "a", status: "opened", title: "x", at: "yesterday"})).toThrow(
            /ISO 8601/
        );
    });

    it("dispatches by source and maps severities", () => {
        expect(normalizeAlert("generic", fixture("generic-alert"), NOW)).toHaveLength(1);
        expect(normalizeAlert("alertmanager", fixture("alertmanager"), NOW)).toHaveLength(2);
        expect(normalizeAlert("sentry", fixture("sentry-issue"), NOW)).toHaveLength(1);
        expect(["fatal", "page", "warn", "info", undefined].map(alertSeverity)).toEqual([
            "critical",
            "critical",
            "warning",
            "info",
            "warning"
        ]);
    });
});

describe("fork detection", () => {
    it("flags GitHub pull requests and workflow runs coming from a fork", () => {
        const pullRequest = withChanges("github-pull-request", (payload) => {
            payload.pull_request.head.repo = {full_name: "mallory/shop", fork: true};
        });
        expect(normalizeGitHub("pull_request", pullRequest)[0]).toMatchObject({fork: true});
        const deletedFork = withChanges("github-pull-request", (payload) => {
            payload.pull_request.head.repo = null;
        });
        expect(normalizeGitHub("pull_request", deletedFork)[0]).toMatchObject({fork: true});
        const run = withChanges("github-workflow-run", (payload) => {
            payload.workflow_run.head_repository = {full_name: "mallory/shop"};
            payload.workflow_run.pull_requests = [];
        });
        expect(normalizeGitHub("workflow_run", run, NOW)[0]).toMatchObject({fork: true});
    });

    it("flags GitLab merge requests and their pipelines coming from another project", () => {
        const mergeRequest = withChanges("gitlab-merge-request", (payload) => {
            payload.object_attributes.source_project_id = 999;
            payload.object_attributes.target_project_id = 12;
        });
        expect(normalizeGitLab("Merge Request Hook", mergeRequest)[0]).toMatchObject({fork: true});
        const pipeline = withChanges("gitlab-pipeline", (payload) => {
            payload.merge_request = {...payload.merge_request, source_project_id: 999, target_project_id: 12};
        });
        expect(normalizeGitLab("Pipeline Hook", pipeline)[0]).toMatchObject({fork: true});
    });
});
