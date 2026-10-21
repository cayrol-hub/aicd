import {isRecord} from "./jsonrpc.js";

/** The JSON Schema subset tool inputs are written in, and that `validateArguments` enforces. */
export interface JsonSchema {
    type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
    enum?: readonly (string | number | boolean)[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    items?: JsonSchema;
    maxItems?: number;
    default?: unknown;
}

function typeOk(type: JsonSchema["type"], value: unknown): boolean {
    switch (type) {
        case undefined:
            return true;
        case "object":
            return isRecord(value);
        case "array":
            return Array.isArray(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        default:
            return typeof value === type;
    }
}

/**
 * Checks `value` against `schema` (type, required, additionalProperties, enum, bounds, lengths, items) and
 * returns the problems found, empty when valid. Keywords outside this subset are ignored.
 */
export function validateArguments(schema: JsonSchema, value: unknown, path = "arguments"): string[] {
    if (!typeOk(schema.type, value)) {
        const article = schema.type && /^[aeiou]/.test(schema.type) ? "an" : "a";
        return [`${path} must be ${article} ${schema.type}`];
    }
    const problems: string[] = [];
    if (schema.enum && !schema.enum.includes(value as string)) {
        problems.push(`${path} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
    }
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < schema.minimum) {
            problems.push(`${path} must be >= ${schema.minimum}`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            problems.push(`${path} must be <= ${schema.maximum}`);
        }
    }
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            problems.push(`${path} must have at least ${schema.minLength} character(s)`);
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            problems.push(`${path} must have at most ${schema.maxLength} character(s)`);
        }
    }
    if (Array.isArray(value)) {
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            problems.push(`${path} must have at most ${schema.maxItems} item(s)`);
        }
        const items = schema.items;
        if (items)
            value.forEach((item, index) => problems.push(...validateArguments(items, item, `${path}[${index}]`)));
    }
    if (isRecord(value)) {
        for (const name of schema.required ?? []) {
            if (value[name] === undefined) problems.push(`${path}.${name} is required`);
        }
        for (const [name, child] of Object.entries(value)) {
            const property = schema.properties?.[name];
            if (property) {
                if (child !== undefined) problems.push(...validateArguments(property, child, `${path}.${name}`));
            } else if (schema.additionalProperties === false) {
                problems.push(`${path}.${name} is not allowed`);
            }
        }
    }
    return problems;
}
