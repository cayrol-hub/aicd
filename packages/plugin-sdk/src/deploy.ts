export interface DeploymentRef {
    id: string;
    environment: string;
    service?: string;
    version?: string;
    commitSha?: string;
    previousCommitSha?: string;
    startedAt: string;
    url?: string;
}

export type DeploymentState = "in_progress" | "success" | "failed" | "paused" | "rolled_back" | "unknown";

export interface Deployer {
    readonly name: string;
    getState(deployment: DeploymentRef): Promise<DeploymentState>;
    pause(deployment: DeploymentRef): Promise<void>;
    rollback(deployment: DeploymentRef): Promise<void>;
}
