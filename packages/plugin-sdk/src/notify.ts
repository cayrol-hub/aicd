export interface Notification {
    title: string;
    text: string;
    severity: "info" | "warning" | "critical";
    url?: string;
    fields?: Record<string, string>;
}

export interface Notifier {
    readonly name: string;
    send(notification: Notification): Promise<void>;
}
