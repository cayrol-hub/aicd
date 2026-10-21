import type {DeploymentRef} from "@aicd-ci/plugin-sdk";

/** What a deployer is configured to drive. */
export interface DeployTarget {
    /** Names the deployment's `service` may take to be ours (application, rollout name…). Empty: any. */
    services: string[];
    environment?: string;
}

/** Thrown when a deployer is asked to act on a deployment it does not own. */
export class DeploymentMismatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeploymentMismatchError";
    }
}

/**
 * Refuses a deployment that contradicts the configuration (other environment, other service), and one that
 * nothing ties to it (no environment configured and no service on the deployment): acting on the wrong
 * application is worse than not acting.
 */
export function assertTarget(deployer: string, target: DeployTarget, deployment: DeploymentRef): void {
    if (target.environment !== undefined && deployment.environment !== target.environment) {
        throw new DeploymentMismatchError(
            `${deployer}: deployment ${deployment.id} is in environment "${deployment.environment}", this deployer drives "${target.environment}"`
        );
    }
    if (
        deployment.service !== undefined &&
        target.services.length > 0 &&
        !target.services.includes(deployment.service)
    ) {
        throw new DeploymentMismatchError(
            `${deployer}: deployment ${deployment.id} is for service "${deployment.service}", this deployer drives ${target.services.map((s) => `"${s}"`).join(", ")}`
        );
    }
    if (target.environment === undefined && deployment.service === undefined) {
        throw new DeploymentMismatchError(
            `${deployer}: cannot tell whether deployment ${deployment.id} is ours (no service on the deployment, no environment configured)`
        );
    }
}

export function matchesTarget(target: DeployTarget, deployment: DeploymentRef): boolean {
    try {
        assertTarget("", target, deployment);
        return true;
    } catch {
        return false;
    }
}
